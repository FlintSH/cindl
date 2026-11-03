/**
 * In-memory SYNTHETIC implementation of CindlClientApi for UI development,
 * component tests and documentation screenshots. It never contacts Hermes and
 * always reports `link.demo = true` so every client shows a "Synthetic demo"
 * banner. Integration tests of the real adapter will use a fake Hermes server
 * (in progress); this scenario only exercises UI behaviour.
 */
import { sha256Hex } from '@cindl/client-core'
import {
  assertAnswerable,
  type Capability,
  type CapabilityId,
  type CapabilityMap,
  type CindlClientApi,
  CindlError,
  type CindlEvent,
  clarifyAnswersComplete,
  type Conversation,
  type DisplayState,
  type LinkState,
  type OpArgs,
  type OpName,
  type OpResult,
  parseOpArgs,
  type PendingPrompt,
  type Routine,
  type ServerRequest,
  type ToolActivity,
  type VersionedDocument,
} from '@cindl/contracts'
import * as data from './data.ts'

export interface ScenarioTimers {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ScenarioOptions {
  /** Multiplies every scripted delay. 0 = synchronous-as-possible (tests). */
  speed?: number
  timers?: ScenarioTimers
}

const realTimers: ScenarioTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Hermes v0.22.5's default store limits (tools/memory_tool_store.py:186); profiles can change them. */
const MEMORY_LIMITS = { memory: 2_200, profile: 1_375 } as const

const unsupported: Partial<Record<CapabilityId, string>> = {
  'connections.accounts':
    'Hermes v0.22.5 has no safe account-coverage source for local browser or vault logins.',
  'artifacts.list':
    'Hermes v0.22.5 has no artifact listing endpoint Cindl can use safely.',
  'attachments.upload': 'Not implemented in Cindl yet.',
}
const limited: Partial<Record<CapabilityId, string>> = {
  'sessions.replay':
    'Hermes replays a bounded, in-memory window after reconnect; it is not durable history.',
  'soul.write':
    'No server-side compare-and-swap at v0.22.5: Cindl re-reads before saving to detect conflicts.',
  'skills.write':
    'No server-side compare-and-swap at v0.22.5: Cindl re-reads before saving to detect conflicts.',
  'computer.view': 'Synthetic demo: no live screen is streamed.',
}

const unavailable: Partial<Record<CapabilityId, string>> = {
  'presence.unified':
    'Not proven: a shared profile is not evidence that every surface talks to one live session authority.',
}

export function scenarioCapabilities(checkedAt: string): CapabilityMap {
  const ids: CapabilityId[] = [
    'chat.stream',
    'chat.interrupt',
    'chat.steer',
    'sessions.list',
    'sessions.create',
    'sessions.history',
    'sessions.replay',
    'sessions.rename',
    'requests.approval',
    'requests.clarify',
    'activity.tools',
    'activity.subagents',
    'activity.processes',
    'routines.read',
    'routines.write',
    'skills.read',
    'skills.write',
    'soul.read',
    'soul.write',
    'memory.overview',
    'memory.text',
    'connections.mcp',
    'connections.accounts',
    'computer.view',
    'computer.control',
    'artifacts.list',
    'attachments.upload',
    'presence.unified',
  ]
  const map: CapabilityMap = {}
  for (const id of ids) {
    const reason = unsupported[id] ?? unavailable[id] ?? limited[id]
    const capability: Capability = {
      id,
      state: unsupported[id]
        ? 'unsupported'
        : unavailable[id]
          ? 'unavailable'
          : limited[id]
            ? 'limited'
            : 'available',
      source: { transport: 'none', endpoint: 'synthetic scenario' },
      checkedAt,
      ...(reason ? { reason } : {}),
    }
    map[id] = capability
  }
  return map
}

type Handler<K extends OpName> = (args: OpArgs<K>) => Promise<OpResult<K>> | OpResult<K>

export function createScenarioClient(options: ScenarioOptions = {}): CindlClientApi & {
  /** Emits the initial snapshot to current subscribers. Called automatically on first subscribe. */
  start(): void
} {
  const speed = options.speed ?? 1
  const timers = options.timers ?? realTimers
  const listeners = new Set<(event: CindlEvent) => void>()
  const iso = () => new Date(timers.now()).toISOString()
  const emit = (event: CindlEvent) => {
    for (const listener of [...listeners]) listener(event)
  }
  const later = (ms: number, callback: () => void) =>
    timers.setTimeout(callback, ms * speed)
  // Memory entries behave like Hermes's learning routes: the id carries the
  // entry's fingerprint, a changed entry is a conflict, and nothing is kept
  // after a delete.
  const memory = data.memoryEntries.map((entry) => ({ ...entry }))
  const source = 'Synthetic fixture (GET /api/learning/node shape)'
  const memoryId = (entry: { store: string; content: string }, index: number) =>
    `memory:${entry.store}:${index}:${sha256Hex(entry.content.trim()).slice(0, 12)}`
  /**
   * Entries in Hermes's order, which numbers them across both stores: agent
   * notes (MEMORY.md) first, then notes about the owner (USER.md)
   * (agent/learning_graph.py `_memory_cards`).
   */
  const ordered = () => [
    ...memory.filter((entry) => entry.store === 'memory'),
    ...memory.filter((entry) => entry.store === 'profile'),
  ]
  const findMemory = (id: string) => {
    const [, store, , fingerprint] = id.split(':')
    const entry = memory.find(
      (candidate) =>
        candidate.store === store &&
        sha256Hex(candidate.content.trim()).slice(0, 12) === fingerprint,
    )
    if (!entry)
      throw new CindlError(
        'conflict',
        'This memory entry changed since you read it. Reload it and review again.',
      )
    return entry
  }

  let started = false
  let link: LinkState = {
    phase: 'online',
    auth: 'demo-fixture',
    demo: true,
    since: iso(),
    connectionEpoch: 1,
    replayEpoch: 'demo-epoch-1',
    server: {
      origin: data.SYNTHETIC_ORIGIN,
      hermesVersion: '0.22.5',
      desktopBackendContract: 8,
      authority: 'legacy-sidecar-v8',
      sessionAuthority: false,
    },
  }
  const capabilities = scenarioCapabilities(iso())
  const conversations = new Map(data.conversations.map((c) => [c.id, structuredClone(c)]))
  const tools = new Map(data.tools.map((t) => [t.id, structuredClone(t)]))
  const requests = new Map(data.requests.map((r) => [r.requestId, structuredClone(r)]))
  const prompts = new Map<string, PendingPrompt>()
  const routines = new Map(data.routines.map((r) => [r.id, structuredClone(r)]))
  const skillDocs = new Map(Object.entries(data.skillContent))
  let soul = data.soul
  let display: DisplayState = {
    status: 'running',
    controller: 'agent',
    leaseHeldByThisDevice: false,
    checkedAt: iso(),
  }
  const streams = new Map<string, unknown[]>()
  let sequence = 0

  const doc = (key: string, content: string, source: string): VersionedDocument => ({
    key,
    content,
    version: sha256Hex(content),
    readAt: iso(),
    source,
  })

  const setConversation = (id: string, patch: Partial<Conversation>) => {
    const conversation = conversations.get(id)
    if (!conversation) return
    const next = { ...conversation, ...patch }
    conversations.set(id, next)
    emit({ type: 'conversation.upserted', conversation: next })
  }

  const streamReply = (
    conversationId: string,
    reply: string,
    tool?: Omit<ToolActivity, 'conversationId'>,
  ) => {
    const messageId = `demo-reply-${++sequence}`
    const handles: unknown[] = []
    streams.set(conversationId, handles)
    setConversation(conversationId, { status: 'working', updatedAt: iso() })
    emit({ type: 'session.status', conversationId, status: 'working' })
    handles.push(
      later(250, () => {
        emit({ type: 'message.started', conversationId, messageId, role: 'assistant' })
        let delay = 0
        if (tool) {
          const activity: ToolActivity = {
            ...tool,
            conversationId,
            status: 'running',
            startedAt: iso(),
          }
          tools.set(activity.id, activity)
          emit({ type: 'tool.updated', activity })
          delay = 600
          handles.push(
            later(delay, () => {
              const done: ToolActivity = {
                ...activity,
                status: 'complete',
                endedAt: iso(),
              }
              tools.set(done.id, done)
              emit({ type: 'tool.updated', activity: done })
            }),
          )
        }
        const words = reply.split(/(?<= )/)
        words.forEach((word, index) => {
          handles.push(
            later(delay + 120 + index * 35, () =>
              emit({
                type: 'message.delta',
                conversationId,
                messageId,
                kind: 'text',
                text: word,
              }),
            ),
          )
        })
        handles.push(
          later(delay + 200 + words.length * 35, () => {
            emit({
              type: 'message.completed',
              conversationId,
              messageId,
              status: 'complete',
            })
            emit({ type: 'session.status', conversationId, status: 'idle' })
            setConversation(conversationId, {
              status: 'idle',
              preview: reply.slice(0, 80),
              updatedAt: iso(),
            })
            streams.delete(conversationId)
          }),
        )
      }),
    )
  }

  const updateRequest = (request: ServerRequest) => {
    requests.set(request.requestId, request)
    emit({ type: 'request.opened', request })
  }

  const handlers: { [K in OpName]: Handler<K> } = {
    'link.get': () => link,
    'capabilities.get': () => capabilities,
    'auth.signIn': () => {
      link = { ...link, phase: 'online', since: iso() }
      emit({ type: 'link.changed', link })
      return link
    },
    'auth.signOut': () => {
      link = { ...link, phase: 'signed-out', since: iso() }
      emit({ type: 'link.changed', link })
      return { localOnly: true as const }
    },
    'conversations.list': () => [...conversations.values()],
    'conversations.create': ({ title }) => {
      const id = `demo-side-${++sequence}`
      const conversation: Conversation = {
        id,
        session: { storedId: id },
        title: title?.trim() || 'New side conversation',
        kind: 'side',
        profile: 'default',
        createdAt: iso(),
        updatedAt: iso(),
        status: 'idle',
      }
      conversations.set(id, conversation)
      emit({ type: 'conversation.upserted', conversation })
      emit({ type: 'history.loaded', conversationId: id, messages: [] })
      return conversation
    },
    'conversations.setMain': ({ conversationId }) => {
      const target = conversations.get(conversationId)
      if (!target)
        throw new CindlError('not-found', 'That conversation no longer exists.')
      for (const conversation of conversations.values())
        if (conversation.kind === 'main' && conversation.id !== conversationId)
          setConversation(conversation.id, { kind: 'side' })
      setConversation(conversationId, { kind: 'main' })
      return conversations.get(conversationId) as Conversation
    },
    'conversations.rename': ({ conversationId, title }) => {
      if (!conversations.has(conversationId))
        throw new CindlError('not-found', 'That conversation no longer exists.')
      setConversation(conversationId, { title })
      return conversations.get(conversationId) as Conversation
    },
    'conversations.history': ({ conversationId }) => {
      const history = {
        messages: data.messages.filter((m) => m.conversationId === conversationId),
        tools: [...tools.values()].filter((t) => t.conversationId === conversationId),
      }
      // Reads that change what a client knows are also emitted, so every store converges.
      for (const activity of history.tools) emit({ type: 'tool.updated', activity })
      emit({ type: 'history.loaded', conversationId, messages: history.messages })
      return history
    },
    'prompt.submit': ({ conversationId, clientId, text }) => {
      if (!conversations.has(conversationId))
        throw new CindlError('not-found', 'That conversation no longer exists.')
      const busy = streams.has(conversationId)
      const prompt: PendingPrompt = {
        clientId,
        conversationId,
        text,
        createdAt: iso(),
        state: 'accepted',
        disposition: busy ? 'queued' : 'streaming',
      }
      prompts.set(clientId, prompt)
      emit({ type: 'prompt.updated', prompt })
      const userId = `demo-user-${clientId}`
      emit({ type: 'message.started', conversationId, messageId: userId, role: 'user' })
      emit({
        type: 'message.completed',
        conversationId,
        messageId: userId,
        status: 'complete',
        text,
      })
      if (!busy)
        streamReply(
          conversationId,
          'This is the synthetic demo, so nothing reached Hermes. In a connected Cindl, Hermes answers here and its tool activity appears above as it happens.',
          {
            id: `demo-tool-${++sequence}`,
            name: 'notes.search',
            title: 'Searched the demo notes (synthetic)',
            status: 'running',
          },
        )
      return prompt
    },
    'prompt.discard': ({ clientId }) => {
      const discarded = prompts.delete(clientId)
      if (discarded) emit({ type: 'prompt.removed', clientId })
      return { discarded }
    },
    'conversation.interrupt': ({ conversationId }) => {
      for (const handle of streams.get(conversationId) ?? []) timers.clearTimeout(handle)
      if (streams.delete(conversationId)) {
        emit({ type: 'session.status', conversationId, status: 'idle' })
        setConversation(conversationId, { status: 'idle' })
      }
      return { requested: true as const }
    },
    'request.answer': ({ requestId, answer }) => {
      const request = requests.get(requestId)
      if (!request) throw new CindlError('not-found', 'This request is no longer open.')
      if (request.status !== 'open')
        throw new CindlError('conflict', 'This request was already answered or closed.')
      assertAnswerable(request)
      if (
        answer.kind === 'approval' &&
        (request.kind !== 'approval' || !request.choices.includes(answer.choice))
      )
        throw new CindlError('invalid', 'That choice was not offered for this request.')
      if (answer.kind !== 'approval' && request.kind !== 'clarify')
        throw new CindlError('invalid', 'This request expects an approval decision.')
      if (answer.kind === 'clarify' && !clarifyAnswersComplete(request, answer.answers))
        throw new CindlError(
          'invalid',
          'Answer or skip every question, then send them together.',
        )
      const answering: ServerRequest = { ...request, status: 'answering', answer }
      updateRequest(answering)
      later(200, () => {
        requests.set(requestId, { ...answering, status: 'answered' })
        emit({
          type: 'request.closed',
          requestId,
          status: 'answered',
          answer,
          connectionEpoch: request.lastSeenEpoch,
        })
        // Only approvals and questions get here, and both belong to a conversation.
        const conversationId = request.conversationId ?? 'demo-main'
        if (request.kind === 'approval') {
          // The turn that asked for approval ends once it has its answer.
          emit({
            type: 'message.completed',
            conversationId,
            messageId: 'm-5',
            status: 'complete',
          })
          const sheet = tools.get('tool-sheet')
          if (sheet) {
            const { progress: _progress, ...rest } = sheet
            const approved = answer.kind === 'approval' && answer.choice === 'once'
            const activity: ToolActivity = approved
              ? {
                  ...rest,
                  status: 'complete',
                  endedAt: iso(),
                  resultPreview: 'Exported 42 rows (synthetic)',
                }
              : { ...rest, status: 'cancelled', endedAt: iso() }
            tools.set(activity.id, activity)
            emit({ type: 'tool.updated', activity })
          }
          streamReply(
            conversationId,
            answer.kind === 'approval' && answer.choice === 'once'
              ? 'Done. The inventory sheet is current: 42 batches, three below reorder level.'
              : 'Understood. I did not run the export.',
          )
        } else {
          streamReply(
            conversationId,
            'Thanks. I will keep that hold and release the other one.',
          )
        }
      })
      return answering
    },
    'routines.list': () => [...routines.values()],
    'routines.setEnabled': ({ id, enabled }) => {
      const routine = routines.get(id)
      if (!routine) throw new CindlError('not-found', 'That routine no longer exists.')
      const next: Routine = { ...routine, enabled }
      routines.set(id, next)
      return next
    },
    'skills.list': () => data.skills,
    'skills.read': ({ name }) => {
      const content = skillDocs.get(name)
      if (content === undefined)
        throw new CindlError('not-found', 'That skill is not installed.')
      return doc(
        `skill:${name}`,
        content,
        'Synthetic fixture (GET /api/skills/content shape)',
      )
    },
    'skills.write': ({ name, content, expectedVersion }) => {
      const current = skillDocs.get(name)
      if (current === undefined)
        throw new CindlError('not-found', 'That skill is not installed.')
      if (sha256Hex(current) !== expectedVersion)
        throw new CindlError(
          'conflict',
          'This skill changed since you opened it. Review the new version first.',
        )
      skillDocs.set(name, content)
      return doc(`skill:${name}`, content, 'Synthetic fixture')
    },
    'soul.read': () =>
      doc(
        'soul:default',
        soul,
        'Synthetic fixture (GET /api/profiles/{name}/soul shape)',
      ),
    'soul.write': ({ content, expectedVersion }) => {
      if (sha256Hex(soul) !== expectedVersion)
        throw new CindlError(
          'conflict',
          'SOUL.md changed since you opened it. Review the new version first.',
        )
      soul = content
      return doc('soul:default', soul, 'Synthetic fixture')
    },
    'memory.overview': () => data.memoryOverview(iso(), memory.length),
    'memory.entries': () =>
      ordered().map((entry, index) => {
        const id = memoryId(entry, index)
        const firstLine = entry.content.split('\n')[0] ?? ''
        return {
          id,
          store: entry.store,
          title: firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine,
          preview: entry.content.slice(0, 1200),
          truncated: entry.content.length > 1200,
        }
      }),
    'memory.read': ({ id }) => {
      const entry = findMemory(id)
      return { id, store: entry.store, content: entry.content, readAt: iso(), source }
    },
    'memory.write': ({ id, content }) => {
      const entry = findMemory(id)
      const used = memory
        .filter((other) => other.store === entry.store && other !== entry)
        .reduce((sum, other) => sum + other.content.length, content.length)
      const limit = MEMORY_LIMITS[entry.store]
      if (used > limit)
        throw new CindlError(
          'invalid',
          `That would put memory at ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} characters. Shorten it.`,
        )
      entry.content = content
      return {
        id: memoryId(entry, ordered().indexOf(entry)),
        store: entry.store,
        content,
        readAt: iso(),
        source,
      }
    },
    'memory.delete': ({ id }) => {
      memory.splice(memory.indexOf(findMemory(id)), 1)
      return { deleted: true as const }
    },
    'connections.mcp': () => data.mcpServers,
    'connections.accounts': () => {
      throw new CindlError('unsupported', unsupported['connections.accounts'] as string)
    },
    'display.status': () => display,
    'display.acquireControl': () => {
      display = {
        ...display,
        controller: 'you',
        leaseHeldByThisDevice: true,
        checkedAt: iso(),
      }
      emit({ type: 'display.changed', display })
      return display
    },
    'display.releaseControl': () => {
      display = {
        ...display,
        controller: 'agent',
        leaseHeldByThisDevice: false,
        checkedAt: iso(),
      }
      emit({ type: 'display.changed', display })
      return display
    },
  }

  const start = () => {
    if (started) return
    started = true
    emit({ type: 'link.changed', link })
    emit({ type: 'capabilities.changed', capabilities })
    for (const conversation of conversations.values())
      emit({ type: 'conversation.upserted', conversation })
    for (const conversation of conversations.values())
      emit({
        type: 'history.loaded',
        conversationId: conversation.id,
        messages: data.messages.filter((m) => m.conversationId === conversation.id),
      })
    for (const activity of tools.values()) emit({ type: 'tool.updated', activity })
    for (const request of requests.values()) emit({ type: 'request.opened', request })
    emit({ type: 'display.changed', display })
  }

  return {
    start,
    async call(name, args) {
      const parsed = parseOpArgs(name, args)
      const handler = handlers[name] as unknown as (a: typeof parsed) => unknown
      return (await handler(parsed)) as never
    },
    subscribe(listener) {
      listeners.add(listener)
      if (!started) queueMicrotask(start)
      return () => listeners.delete(listener)
    },
  }
}
