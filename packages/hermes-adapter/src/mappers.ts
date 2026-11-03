import type {
  Conversation,
  DisplayState,
  McpServerStatus,
  MemoryOverview,
  Message,
  MessagePart,
  Routine,
  Skill,
  ToolActivity,
} from '@cindl/contracts'
import type { z } from 'zod'
import { boundedText, safeText } from './diagnostics.ts'
import type {
  CronJobRow,
  DisplayLease,
  DisplayStatus,
  McpServersStatusResult,
  MemoryResponse,
  SessionListRow,
  SkillsResponse,
  TranscriptMessage,
} from './wire.ts'

/**
 * Hermes v0.22.5 records → Cindl domain objects. Timestamps are normalized to
 * UTC ISO strings (`Z`), which is what the contract accepts; values Hermes
 * cannot date are left out rather than invented.
 */

export function isoFromSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

const PREVIEW_MAX = 400

export function conversationFromRow(
  row: SessionListRow,
  options: { kind: Conversation['kind']; runtimeId?: string; profile?: string },
): Conversation {
  const createdAt = isoFromSeconds(row.started_at)
  const preview = row.preview?.trim()
  return {
    id: row.id,
    session: {
      storedId: row.id,
      ...(options.runtimeId ? { runtimeId: options.runtimeId } : {}),
    },
    title:
      row.title?.trim() || (preview ? safeText(preview, 60) : 'Untitled conversation'),
    kind: options.kind,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(createdAt ? { createdAt, updatedAt: createdAt } : {}),
    status: 'unknown',
    ...(preview ? { preview: safeText(preview, 160) } : {}),
  }
}

function textOf(row: TranscriptMessage): string {
  if (typeof row.text === 'string') return row.text
  if (typeof row.content === 'string') return row.content
  return ''
}

/**
 * A stored transcript (`session.resume`/`session.history` `messages`) as
 * Cindl messages plus tool activity. Tool rows become completed activities
 * anchored in the preceding assistant message.
 */
export function transcriptToHistory(
  conversationId: string,
  rows: readonly TranscriptMessage[],
): { messages: Message[]; tools: ToolActivity[] } {
  const messages: Message[] = []
  const tools: ToolActivity[] = []
  rows.forEach((row, index) => {
    const id = `hermes:${conversationId}:${row.row_id ?? `i${index}`}`
    const createdAt = isoFromSeconds(row.timestamp)
    if (row.role === 'tool') {
      const name = row.name ?? 'tool'
      const result = textOf(row)
      const activity: ToolActivity = {
        id,
        conversationId,
        name,
        title: safeText(row.context ?? name, 120),
        status: 'complete',
        ...(createdAt ? { startedAt: createdAt, endedAt: createdAt } : {}),
        ...(result ? { resultPreview: boundedText(result, PREVIEW_MAX) } : {}),
      }
      tools.push(activity)
      const anchor = messages.findLast((m) => m.role === 'assistant')
      anchor?.parts.push({ type: 'tool', toolId: id })
      return
    }
    if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system') return
    const parts: MessagePart[] = []
    if (row.role === 'assistant' && row.reasoning)
      parts.push({ type: 'reasoning', text: row.reasoning })
    const text = textOf(row)
    if (text) parts.push({ type: 'text', text })
    messages.push({
      id,
      conversationId,
      role: row.role,
      parts,
      status: 'complete',
      ...(createdAt ? { createdAt } : {}),
    })
  })
  return { messages, tools }
}

const runStatus = (
  status: string | null | undefined,
): NonNullable<Routine['lastRun']>['status'] => {
  if (status === 'ok') return 'ok'
  if (status === 'error' || status === 'delivery_failed' || status === 'blocked_config')
    return 'error'
  return 'unknown'
}

export function routineFromJob(job: CronJobRow): Routine {
  const lastRunAt = isoFromString(job.last_run_at)
  const nextRunAt = isoFromString(job.next_run_at)
  return {
    id: job.job_id,
    name: job.name?.trim() || job.job_id,
    schedule: job.schedule ?? '',
    enabled: job.enabled ?? job.state !== 'paused',
    ...(lastRunAt
      ? { lastRun: { at: lastRunAt, status: runStatus(job.last_status) } }
      : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  }
}

export function skillFromRow(row: z.infer<typeof SkillsResponse>[number]): Skill {
  return {
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
    ...(row.provenance ? { source: row.provenance } : {}),
  }
}

const mcpState: Record<string, McpServerStatus['state']> = {
  connected: 'connected',
  connecting: 'connecting',
  failed: 'error',
  disabled: 'disabled',
}

/** Cached MCP health. URLs, commands and arguments are not in the result and never added. */
export function mcpFromStatus(
  result: z.infer<typeof McpServersStatusResult>,
): McpServerStatus[] {
  const checkedAt = isoFromSeconds(result.checked_at)
  return result.servers.map((server) => ({
    name: server.name,
    state: mcpState[server.status] ?? 'unknown',
    toolCount: server.tools,
    ...(checkedAt ? { checkedAt } : {}),
  }))
}

export function memoryOverviewFrom(
  memory: MemoryResponse,
  readAt: string,
): MemoryOverview {
  const items: MemoryOverview['items'] = []
  const files = memory.builtin_files ?? {}
  const size = (bytes: number | undefined) =>
    bytes === undefined
      ? 'unknown size'
      : bytes === 0
        ? 'empty'
        : `${bytes.toLocaleString('en-US')} bytes`
  items.push({
    key: 'builtin:memory',
    label: 'Agent notes (MEMORY.md)',
    detail: size(files.memory),
  })
  items.push({
    key: 'builtin:user',
    label: 'User profile (USER.md)',
    detail: size(files.user),
  })
  for (const provider of memory.providers ?? [])
    items.push({
      key: `provider:${provider.name}`,
      label: `Memory provider: ${safeText(provider.name, 60)}`,
      detail:
        provider.name === memory.active
          ? provider.available === false
            ? 'active, unavailable'
            : 'active'
          : provider.available === false
            ? 'unavailable'
            : 'available',
    })
  return { items, source: 'GET /api/memory', readAt }
}

/**
 * The agent screen as Cindl shows it. `viewerHashes` are the
 * `sha256(viewer_id)[:12]` values of viewer ids this device minted; Hermes
 * publishes only that hash (tools/bot_desktop/lease.py:67).
 */
export function displayState(
  status: Pick<DisplayStatus, 'supported' | 'installed' | 'running'> | undefined,
  lease: DisplayLease | undefined,
  viewerHashes: { current?: string | undefined; previous: ReadonlySet<string> },
  checkedAt: string,
): DisplayState {
  const screen: DisplayState['status'] = !status
    ? 'unknown'
    : !status.supported || !status.installed
      ? 'unavailable'
      : status.running
        ? 'running'
        : 'stopped'
  let controller: DisplayState['controller'] = 'unknown'
  let held = false
  if (lease) {
    if (lease.holder === 'agent') controller = 'agent'
    else if (lease.viewer_hash && lease.viewer_hash === viewerHashes.current) {
      controller = 'you'
      held = true
    } else if (lease.viewer_hash && viewerHashes.previous.has(lease.viewer_hash))
      // Our viewer id from an earlier connection: Hermes binds viewer ids to the
      // connection that minted them, so this device cannot release it any more.
      controller = 'you'
    else controller = 'another-viewer'
  }
  return { status: screen, controller, leaseHeldByThisDevice: held, checkedAt }
}
