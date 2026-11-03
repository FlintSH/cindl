import type { CindlEvent, Conversation, ToolActivity, Usage } from '@cindl/contracts'
import { z } from 'zod'
import { boundedText, safeText } from './diagnostics.ts'
import type { HermesEventParams } from './rpc.ts'
import { handledNotifications, type HandledNotification } from './upstream-surface.ts'
import { DisplayLease, DisplayStatus } from './wire.ts'

/**
 * Turns Hermes `event` notifications (tui_gateway/contracts/events.py at
 * v0.22.5) into Cindl events. Hermes wire events never reach UI code. Types
 * outside `handledNotifications` are ignored, never guessed. Payloads are
 * parsed defensively; a payload that does not match is dropped.
 *
 * Tool arguments and results can be private: previews are redacted and
 * truncated here, and nothing is logged.
 */

/** Side effects the direct client applies with state the normalizer does not own. */
export type NormalizerEffect =
  | { kind: 'title'; storedId: string; title: string }
  | { kind: 'sessions-changed' }
  | { kind: 'cron-changed' }
  | { kind: 'skills-changed' }
  | { kind: 'request-cancelled'; requestId: string; reason: string }
  | {
      kind: 'approvals-cancelled'
      runtimeSessionId: string
      requestIds: string[]
      reason: string
    }
  | { kind: 'display-status'; status: DisplayStatus }
  | { kind: 'display-lease'; profileKey: string; lease: DisplayLease }
  | { kind: 'session-reclaimed'; runtimeSessionId: string }
  | { kind: 'turn-ended'; runtimeSessionId: string }

export interface Normalized {
  events: CindlEvent[]
  effects: NormalizerEffect[]
}

export interface NormalizerOptions {
  /** Conversation id for a runtime session id, if this client knows it. */
  conversationFor(runtimeSessionId: string): string | undefined
  /** Current time as an ISO string. */
  now(): string
}

const PREVIEW_MAX = 400

const Text = z.object({ text: z.string() })
const MessageDelta = z.object({ text: z.string().nullable() })
const MessageInterim = z.object({ text: z.string(), already_streamed: z.boolean() })
const MessageComplete = z.object({
  text: z.unknown().optional(),
  status: z.enum(['complete', 'error', 'interrupted']).nullable().optional(),
  error: z.string().nullable().optional(),
})
const ToolGenerating = z.object({ name: z.string() })
const ToolLabelText = z.object({ text: z.string() })
const ToolStart = z.object({
  tool_id: z.string().min(1),
  name: z.string(),
  context: z.string().nullable().optional(),
  args_text: z.string().nullable().optional(),
  preview: z.string().nullable().optional(),
  labels: z.array(ToolLabelText).nullable().optional(),
})
const ToolProgress = z.object({
  tool_id: z.string().min(1),
  name: z.string(),
  progress: z.number(),
  total: z.number().nullable().optional(),
  percent: z.number().nullable().optional(),
  message: z.string().nullable().optional(),
})
const ToolComplete = z.object({
  tool_id: z.string().min(1),
  name: z.string(),
  summary: z.string().nullable().optional(),
  result_text: z.string().nullable().optional(),
})
const ToolOutputRisk = z.object({
  tool_id: z.string().min(1),
  name: z.string(),
  risk: z.string(),
  findings: z.array(z.string()),
})
const StatusUpdate = z.object({ kind: z.string(), text: z.string() })
const SessionInfo = z.object({
  running: z.boolean().optional(),
  title: z.string().optional(),
  stored_session_id: z.string().optional(),
})
const UsageNumbers = z.object({
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().nullable().optional(),
})
const SessionUsage = z.object({
  usage: UsageNumbers.nullable().optional(),
  input_tokens: z.number().int().nonnegative().nullable().optional(),
  output_tokens: z.number().int().nonnegative().nullable().optional(),
})
const SessionTitle = z.object({ session_id: z.string().min(1), title: z.string() })
const Message = z.object({ message: z.string() })
const RequestCancel = z.object({
  id: z.string().min(1),
  method: z.string(),
  reason: z.string(),
})
const ApprovalCancelled = z.object({
  session_id: z.string(),
  reason: z.string(),
  request_ids: z.array(z.string()),
})
const DisplayLeasePayload = z.object({ profile_key: z.string(), lease: DisplayLease })
const SubagentEvent = z.object({
  goal: z.string(),
  subagent_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
})
const SessionReclaimed = z.object({ session_id: z.string(), reason: z.string() })

const handled = new Set<string>(handledNotifications)

export class EventNormalizer {
  readonly #options: NormalizerOptions
  /** Current assistant message per runtime session. */
  readonly #message = new Map<string, string>()
  readonly #reasoningStreamed = new Set<string>()
  /** Last known activity per id, so partial tool events can be re-emitted whole. */
  readonly #tools = new Map<string, ToolActivity>()
  /** Hermes tool_id → activity id (a tool.generating card adopted by tool.start). */
  readonly #toolAlias = new Map<string, string>()
  /** Pending tool.generating activity per `${runtimeSessionId}\u0000${name}`. */
  readonly #generating = new Map<string, string>()
  readonly #status = new Map<string, Conversation['status']>()
  #counter = 0

  constructor(options: NormalizerOptions) {
    this.#options = options
  }

  /** Forget per-turn state for a runtime session (reset after a resync). */
  forgetSession(runtimeSessionId: string): void {
    this.#message.delete(runtimeSessionId)
    for (const key of this.#generating.keys())
      if (key.startsWith(`${runtimeSessionId}\u0000`)) this.#generating.delete(key)
  }

  normalize(params: HermesEventParams): Normalized {
    const out: Normalized = { events: [], effects: [] }
    if (!handled.has(params.type)) return out
    const type = params.type as HandledNotification
    const payload: unknown = params.payload
    const sid = typeof params.session_id === 'string' ? params.session_id : ''
    const seq = typeof params.seq === 'number' ? params.seq : undefined
    const conversationId = sid ? this.#options.conversationFor(sid) : undefined
    const inConversation = (fn: (conversationId: string) => void) => {
      if (conversationId) fn(conversationId)
    }

    switch (type) {
      case 'gateway.ready':
        return out
      case 'message.start':
        inConversation((cid) => {
          const messageId = this.#newMessageId(sid, seq)
          out.events.push(
            {
              type: 'message.started',
              conversationId: cid,
              messageId,
              role: 'assistant',
            },
            ...this.#setStatus(sid, cid, 'working'),
          )
        })
        return out
      case 'message.delta': {
        const parsed = MessageDelta.safeParse(payload)
        if (parsed.success && parsed.data.text)
          inConversation((cid) =>
            this.#delta(out, sid, cid, seq, 'text', parsed.data.text ?? ''),
          )
        return out
      }
      case 'message.interim': {
        const parsed = MessageInterim.safeParse(payload)
        if (parsed.success && !parsed.data.already_streamed && parsed.data.text)
          inConversation((cid) =>
            this.#delta(out, sid, cid, seq, 'text', parsed.data.text),
          )
        return out
      }
      case 'reasoning.delta':
      case 'thinking.delta': {
        const parsed = Text.safeParse(payload)
        if (parsed.success && parsed.data.text)
          inConversation((cid) => {
            const messageId = this.#delta(
              out,
              sid,
              cid,
              seq,
              'reasoning',
              parsed.data.text,
            )
            this.#reasoningStreamed.add(messageId)
          })
        return out
      }
      case 'reasoning.available': {
        const parsed = Text.safeParse(payload)
        if (parsed.success && parsed.data.text)
          inConversation((cid) => {
            const current = this.#message.get(sid)
            // A provider that streamed its reasoning sends the block again; skip the copy.
            if (current && this.#reasoningStreamed.has(current)) return
            this.#delta(out, sid, cid, seq, 'reasoning', parsed.data.text)
          })
        return out
      }
      case 'message.complete': {
        const parsed = MessageComplete.safeParse(payload)
        if (!parsed.success) return out
        inConversation((cid) => {
          const messageId =
            this.#message.get(sid) ?? this.#newMessageId(sid, seq, cid, out)
          const { status, error, text } = parsed.data
          const final = status ?? (error ? 'error' : 'complete')
          out.events.push({
            type: 'message.completed',
            conversationId: cid,
            messageId,
            status: final,
            ...(typeof text === 'string' && text ? { text } : {}),
          })
          if (error)
            out.events.push({
              type: 'notice',
              level: 'error',
              message: `Hermes reported an error: ${safeText(error, 200)}`,
            })
          out.events.push(...this.#setStatus(sid, cid, 'idle'))
          this.#message.delete(sid)
          this.#reasoningStreamed.delete(messageId)
        })
        if (sid) out.effects.push({ kind: 'turn-ended', runtimeSessionId: sid })
        return out
      }
      case 'tool.generating': {
        const parsed = ToolGenerating.safeParse(payload)
        if (!parsed.success) return out
        inConversation((cid) => {
          const id = `hermes:${sid}:gen:${seq ?? ++this.#counter}`
          this.#generating.set(`${sid}\u0000${parsed.data.name}`, id)
          this.#emitTool(out, {
            id,
            conversationId: cid,
            name: parsed.data.name,
            title: parsed.data.name,
            status: 'generating',
            startedAt: this.#options.now(),
          })
          out.events.push(...this.#setStatus(sid, cid, 'working'))
        })
        return out
      }
      case 'tool.start': {
        const parsed = ToolStart.safeParse(payload)
        if (!parsed.success) return out
        inConversation((cid) => {
          const data = parsed.data
          const pendingKey = `${sid}\u0000${data.name}`
          const adopted = this.#generating.get(pendingKey)
          this.#generating.delete(pendingKey)
          const id = adopted ?? `hermes:${sid}:tool:${data.tool_id}`
          this.#toolAlias.set(`${sid}\u0000${data.tool_id}`, id)
          const preview = data.preview ?? data.args_text
          const label = data.labels?.find((l) => l.text)?.text
          const previous = this.#tools.get(id)
          this.#emitTool(out, {
            id,
            conversationId: cid,
            name: data.name,
            title: safeText(label ?? data.context ?? data.name, 120),
            status: 'running',
            startedAt: previous?.startedAt ?? this.#options.now(),
            ...(preview ? { argsPreview: boundedText(preview, PREVIEW_MAX) } : {}),
          })
          out.events.push(...this.#setStatus(sid, cid, 'working'))
        })
        return out
      }
      case 'tool.progress': {
        const parsed = ToolProgress.safeParse(payload)
        if (!parsed.success) return out
        const { tool_id, message, percent, total, progress } = parsed.data
        const activity = this.#toolFor(sid, tool_id)
        if (activity) {
          const text =
            message ??
            (percent != null
              ? `${percent}%`
              : total
                ? `${progress} of ${total}`
                : String(progress))
          this.#emitTool(out, { ...activity, progress: safeText(text, 160) })
        }
        return out
      }
      case 'tool.complete': {
        const parsed = ToolComplete.safeParse(payload)
        if (!parsed.success) return out
        const activity = this.#toolFor(sid, parsed.data.tool_id)
        if (activity) {
          const { progress: _progress, ...rest } = activity
          const result = parsed.data.summary ?? parsed.data.result_text
          this.#emitTool(out, {
            ...rest,
            status: 'complete',
            endedAt: this.#options.now(),
            ...(result ? { resultPreview: boundedText(result, PREVIEW_MAX) } : {}),
          })
        }
        return out
      }
      case 'tool.output_risk': {
        const parsed = ToolOutputRisk.safeParse(payload)
        if (!parsed.success) return out
        const activity = this.#toolFor(sid, parsed.data.tool_id)
        if (activity) {
          const reason = parsed.data.findings.join('; ')
          this.#emitTool(out, {
            ...activity,
            outputRisk: {
              level: safeText(parsed.data.risk, 40),
              ...(reason ? { reason: safeText(reason, 240) } : {}),
            },
          })
        }
        return out
      }
      case 'status.update': {
        const parsed = StatusUpdate.safeParse(payload)
        if (parsed.success)
          inConversation((cid) =>
            out.events.push({
              type: 'session.status',
              conversationId: cid,
              status: this.#status.get(sid) ?? 'unknown',
              detail: safeText(parsed.data.text, 160),
            }),
          )
        return out
      }
      case 'session.info': {
        const parsed = SessionInfo.safeParse(payload)
        if (!parsed.success) return out
        inConversation((cid) => {
          if (parsed.data.running !== undefined)
            out.events.push(
              ...this.#setStatus(sid, cid, parsed.data.running ? 'working' : 'idle'),
            )
          const title = parsed.data.title?.trim()
          if (title)
            out.effects.push({
              kind: 'title',
              storedId: parsed.data.stored_session_id ?? cid,
              title: safeText(title, 200),
            })
        })
        return out
      }
      case 'session.usage': {
        const parsed = SessionUsage.safeParse(payload)
        if (!parsed.success) return out
        inConversation((cid) => {
          const { usage, input_tokens, output_tokens } = parsed.data
          const next: Usage = {}
          const input = input_tokens ?? usage?.input
          const output = output_tokens ?? usage?.output
          if (input != null) next.inputTokens = input
          if (output != null) next.outputTokens = output
          if (usage?.cost_usd != null) next.costUsd = usage.cost_usd
          out.events.push({ type: 'usage.updated', conversationId: cid, usage: next })
        })
        return out
      }
      case 'session.title': {
        const parsed = SessionTitle.safeParse(payload)
        if (parsed.success && parsed.data.title.trim())
          out.effects.push({
            kind: 'title',
            storedId: parsed.data.session_id,
            title: safeText(parsed.data.title, 200),
          })
        return out
      }
      case 'sessions.changed':
        out.effects.push({ kind: 'sessions-changed' })
        return out
      case 'cron.changed':
        out.effects.push({ kind: 'cron-changed' })
        return out
      case 'skills.changed':
        out.effects.push({ kind: 'skills-changed' })
        return out
      case 'error': {
        const parsed = Message.safeParse(payload)
        if (parsed.success)
          out.events.push({
            type: 'notice',
            level: 'error',
            message: `Hermes: ${safeText(parsed.data.message, 200)}`,
          })
        return out
      }
      case 'notice': {
        const parsed = Message.safeParse(payload)
        if (parsed.success)
          out.events.push({
            type: 'notice',
            level: 'info',
            message: `Hermes: ${safeText(parsed.data.message, 200)}`,
          })
        return out
      }
      case 'request.cancel': {
        const parsed = RequestCancel.safeParse(payload)
        if (parsed.success)
          out.effects.push({
            kind: 'request-cancelled',
            requestId: parsed.data.id,
            reason: parsed.data.reason,
          })
        return out
      }
      case 'approval.cancelled': {
        const parsed = ApprovalCancelled.safeParse(payload)
        if (parsed.success)
          out.effects.push({
            kind: 'approvals-cancelled',
            runtimeSessionId: parsed.data.session_id || sid,
            requestIds: parsed.data.request_ids,
            reason: parsed.data.reason,
          })
        return out
      }
      case 'background.complete':
        out.events.push({
          type: 'notice',
          level: 'info',
          message: 'A Hermes background task finished.',
        })
        return out
      case 'display.status': {
        const parsed = DisplayStatus.safeParse(payload)
        if (parsed.success)
          out.effects.push({ kind: 'display-status', status: parsed.data })
        return out
      }
      case 'display.lease': {
        const parsed = DisplayLeasePayload.safeParse(payload)
        if (parsed.success)
          out.effects.push({
            kind: 'display-lease',
            profileKey: parsed.data.profile_key,
            lease: parsed.data.lease,
          })
        return out
      }
      case 'subagent.start':
      case 'subagent.progress':
      case 'subagent.complete': {
        const parsed = SubagentEvent.safeParse(payload)
        if (!parsed.success) return out
        inConversation((cid) => this.#subagent(out, type, cid, parsed.data))
        return out
      }
      case 'session.reclaimed': {
        const parsed = SessionReclaimed.safeParse(payload)
        if (!parsed.success) return out
        const runtimeSessionId = parsed.data.session_id || sid
        this.forgetSession(runtimeSessionId)
        out.effects.push({ kind: 'session-reclaimed', runtimeSessionId })
        return out
      }
    }
  }

  #newMessageId(sid: string, seq: number | undefined, cid?: string, out?: Normalized) {
    const messageId = `hermes:${sid}:m${seq ?? `x${++this.#counter}`}`
    this.#message.set(sid, messageId)
    if (cid && out)
      out.events.push({
        type: 'message.started',
        conversationId: cid,
        messageId,
        role: 'assistant',
      })
    return messageId
  }

  #delta(
    out: Normalized,
    sid: string,
    cid: string,
    seq: number | undefined,
    kind: 'text' | 'reasoning',
    text: string,
  ): string {
    const messageId = this.#message.get(sid) ?? this.#newMessageId(sid, seq, cid, out)
    out.events.push({ type: 'message.delta', conversationId: cid, messageId, kind, text })
    return messageId
  }

  #toolFor(sid: string, toolId: string): ToolActivity | undefined {
    const id =
      this.#toolAlias.get(`${sid}\u0000${toolId}`) ?? `hermes:${sid}:tool:${toolId}`
    return this.#tools.get(id)
  }

  #emitTool(out: Normalized, activity: ToolActivity): void {
    this.#tools.set(activity.id, activity)
    out.events.push({ type: 'tool.updated', activity })
  }

  #setStatus(sid: string, cid: string, status: Conversation['status']): CindlEvent[] {
    if (this.#status.get(sid) === status) return []
    this.#status.set(sid, status)
    return [{ type: 'session.status', conversationId: cid, status }]
  }

  #subagent(
    out: Normalized,
    type: 'subagent.start' | 'subagent.progress' | 'subagent.complete',
    cid: string,
    data: z.infer<typeof SubagentEvent>,
  ): void {
    const key = data.subagent_id ?? `goal-${safeText(data.goal, 60)}`
    const id = `hermes:subagent:${key}`
    const previous = this.#tools.get(id)
    const base: ToolActivity = previous ?? {
      id,
      conversationId: cid,
      name: 'delegate',
      title: safeText(data.goal, 120) || 'Delegated task',
      status: 'running',
      startedAt: this.#options.now(),
    }
    if (type === 'subagent.complete') {
      const { progress: _progress, ...rest } = base
      const status = data.status ?? 'completed'
      const summary = data.summary ?? data.text
      this.#emitTool(out, {
        ...rest,
        status:
          status === 'completed'
            ? 'complete'
            : status === 'interrupted'
              ? 'cancelled'
              : 'error',
        endedAt: this.#options.now(),
        ...(summary ? { resultPreview: boundedText(summary, PREVIEW_MAX) } : {}),
      })
      return
    }
    const progress = data.tool_name ?? data.text
    this.#emitTool(out, {
      ...base,
      status: 'running',
      ...(type === 'subagent.progress' && progress
        ? { progress: safeText(progress, 160) }
        : {}),
    })
  }
}
