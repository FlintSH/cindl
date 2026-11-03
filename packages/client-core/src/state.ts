import type {
  CapabilityMap,
  CindlEvent,
  Conversation,
  DisplayState,
  LinkState,
  Message,
  PendingPrompt,
  ServerRequest,
  ToolActivity,
  Usage,
} from '@cindl/contracts'
import {
  entry,
  hasEntry,
  records,
  withEntry,
  withoutEntry,
  type Records,
} from './records.ts'

export interface Notice {
  id: number
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface ClientState {
  link: LinkState
  capabilities: CapabilityMap
  conversations: Records<Conversation>
  messages: Records<readonly Message[]>
  tools: Records<ToolActivity>
  prompts: Records<PendingPrompt>
  /** Keyed by Hermes request id (`srq-…`), stable across reconnects. */
  requests: Records<ServerRequest>
  usage: Records<Usage>
  display: DisplayState | undefined
  notices: readonly Notice[]
}

export function initialState(link: LinkState): ClientState {
  return {
    link,
    capabilities: {},
    conversations: records(),
    messages: records(),
    tools: records(),
    prompts: records(),
    requests: records(),
    usage: records(),
    display: undefined,
    notices: [],
  }
}

const OPEN_STATES: ReadonlySet<ServerRequest['status']> = new Set(['open', 'answering'])

/**
 * Final text from Hermes. When it extends what streamed (the usual case), each
 * streamed text part keeps its place between tool rows and any remainder is
 * appended to the last one. Otherwise the final text replaces the streamed
 * text at its first position.
 */
function withFinalText(parts: Message['parts'], text: string): Message['parts'] {
  const textParts = parts.filter((part) => part.type === 'text')
  if (textParts.map((part) => part.text).join('') === text) return parts
  let consumed = 0
  let prefix = true
  for (const part of textParts) {
    if (text.startsWith(part.text, consumed)) consumed += part.text.length
    else {
      prefix = false
      break
    }
  }
  if (prefix && textParts.length) {
    const lastIndex = parts.findLastIndex((part) => part.type === 'text')
    const rest = text.slice(consumed)
    return parts.map((part, index) =>
      index === lastIndex && part.type === 'text'
        ? { type: 'text', text: part.text + rest }
        : part,
    )
  }
  const first = parts.findIndex((part) => part.type === 'text')
  if (first < 0) return [...parts, { type: 'text', text }]
  return parts.flatMap((part, index): Message['parts'] =>
    part.type !== 'text' ? [part] : index === first ? [{ type: 'text', text }] : [],
  )
}

const MAX_NOTICES = 20

function patchMessages(
  state: ClientState,
  conversationId: string,
  update: (messages: readonly Message[]) => readonly Message[],
): ClientState {
  const current = entry(state.messages, conversationId) ?? []
  const next = update(current)
  return next === current
    ? state
    : { ...state, messages: withEntry(state.messages, conversationId, next) }
}

function appendDelta(
  message: Message,
  kind: 'text' | 'reasoning',
  text: string,
): Message {
  const parts = [...message.parts]
  const last = parts.at(-1)
  if (last && last.type === kind)
    parts[parts.length - 1] = { type: kind, text: last.text + text }
  else parts.push({ type: kind, text })
  return { ...message, parts }
}

/** Pure reducer: the only way client state changes. */
export function reduce(state: ClientState, event: CindlEvent): ClientState {
  switch (event.type) {
    case 'link.changed':
      return { ...state, link: event.link }
    case 'capabilities.changed':
      return { ...state, capabilities: event.capabilities }
    case 'conversation.upserted':
      return {
        ...state,
        conversations: withEntry(
          state.conversations,
          event.conversation.id,
          event.conversation,
        ),
      }
    case 'conversation.removed': {
      return {
        ...state,
        conversations: withoutEntry(state.conversations, event.conversationId),
        messages: withoutEntry(state.messages, event.conversationId),
      }
    }
    case 'history.loaded':
      return {
        ...state,
        messages: withEntry(state.messages, event.conversationId, event.messages),
      }
    case 'history.reset': {
      return { ...state, messages: withoutEntry(state.messages, event.conversationId) }
    }
    case 'message.started':
      return patchMessages(state, event.conversationId, (messages) =>
        messages.some((m) => m.id === event.messageId)
          ? messages
          : [
              ...messages,
              {
                id: event.messageId,
                conversationId: event.conversationId,
                role: event.role,
                parts: [],
                status: 'streaming',
              },
            ],
      )
    case 'message.delta':
      return patchMessages(state, event.conversationId, (messages) => {
        const index = messages.findIndex((m) => m.id === event.messageId)
        if (index < 0)
          return [
            ...messages,
            appendDelta(
              {
                id: event.messageId,
                conversationId: event.conversationId,
                role: 'assistant',
                parts: [],
                status: 'streaming',
              },
              event.kind,
              event.text,
            ),
          ]
        const next = [...messages]
        next[index] = appendDelta(messages[index] as Message, event.kind, event.text)
        return next
      })
    case 'message.completed':
      return patchMessages(state, event.conversationId, (messages) => {
        const index = messages.findIndex((m) => m.id === event.messageId)
        if (index < 0) {
          // Completion for a message this client never saw start (e.g. joined mid-turn).
          if (event.text === undefined) return messages
          return [
            ...messages,
            {
              id: event.messageId,
              conversationId: event.conversationId,
              role: 'assistant',
              parts: [{ type: 'text', text: event.text }],
              status: event.status,
            },
          ]
        }
        const message = messages[index] as Message
        const parts =
          event.text === undefined
            ? message.parts
            : withFinalText(message.parts, event.text)
        const next = [...messages]
        next[index] = { ...message, parts, status: event.status }
        return next
      })
    case 'tool.updated': {
      const { activity } = event
      const known = hasEntry(state.tools, activity.id)
      const withTool = { ...state, tools: withEntry(state.tools, activity.id, activity) }
      if (known) return withTool
      // Anchor a new tool in the conversation's streaming assistant message so it renders in
      // order, unless a loaded transcript already places it.
      return patchMessages(withTool, activity.conversationId, (messages) => {
        const placed = messages.some((m) =>
          m.parts.some((part) => part.type === 'tool' && part.toolId === activity.id),
        )
        if (placed) return messages
        const index = messages.findLastIndex(
          (m) => m.role === 'assistant' && m.status === 'streaming',
        )
        if (index < 0) return messages
        const message = messages[index] as Message
        const next = [...messages]
        next[index] = {
          ...message,
          parts: [...message.parts, { type: 'tool', toolId: activity.id }],
        }
        return next
      })
    }
    case 'prompt.updated':
      return {
        ...state,
        prompts: withEntry(state.prompts, event.prompt.clientId, event.prompt),
      }
    case 'request.opened': {
      const incoming = event.request
      const existing = entry(state.requests, incoming.requestId)
      if (existing) {
        // Never resurrect a request Hermes closed, cancelled or expired.
        if (!OPEN_STATES.has(existing.status) && existing.status !== 'answered')
          return state
        // A re-sent frame while this client's answer is in flight keeps it in flight.
        if (existing.status === 'answering' && existing.answer)
          return {
            ...state,
            requests: withEntry(state.requests, incoming.requestId, {
              ...incoming,
              status: 'answering',
              answer: existing.answer,
            }),
          }
        // Hermes re-sending a request this client answered means that answer did not
        // land (Hermes keeps the first reply): it is answerable again.
      }
      return {
        ...state,
        requests: withEntry(state.requests, incoming.requestId, incoming),
      }
    }
    case 'request.closed': {
      const existing = entry(state.requests, event.requestId)
      if (!existing || !OPEN_STATES.has(existing.status)) return state
      // Hermes tells every client, the answering one included, that a request
      // resolved; if this client sent an answer, record that, nothing more.
      const status = existing.answer ? 'answered' : event.status
      return {
        ...state,
        requests: withEntry(state.requests, event.requestId, { ...existing, status }),
      }
    }
    case 'request.answer-failed': {
      const existing = entry(state.requests, event.requestId)
      if (!existing || existing.status !== 'answering') return state
      const { answer: _answer, ...rest } = existing
      return {
        ...state,
        requests: withEntry(state.requests, event.requestId, { ...rest, status: 'open' }),
      }
    }
    case 'requests.synced': {
      const open = new Set(event.openRequestIds)
      let requests = state.requests
      for (const [id, request] of Object.entries(state.requests)) {
        if (request.conversationId !== event.conversationId) continue
        if (!OPEN_STATES.has(request.status) || open.has(id)) continue
        requests = withEntry(requests, id, {
          ...request,
          status: request.answer ? 'answered' : 'resolved-elsewhere',
        })
      }
      return requests === state.requests ? state : { ...state, requests }
    }
    case 'prompt.removed':
      return hasEntry(state.prompts, event.clientId)
        ? { ...state, prompts: withoutEntry(state.prompts, event.clientId) }
        : state
    case 'session.status': {
      const conversation = entry(state.conversations, event.conversationId)
      if (!conversation || conversation.status === event.status) return state
      return {
        ...state,
        conversations: withEntry(state.conversations, event.conversationId, {
          ...conversation,
          status: event.status,
        }),
      }
    }
    case 'usage.updated':
      return {
        ...state,
        usage: withEntry(state.usage, event.conversationId, event.usage),
      }
    case 'display.changed':
      return { ...state, display: event.display }
    case 'notice': {
      const id = (state.notices.at(-1)?.id ?? 0) + 1
      return {
        ...state,
        notices: [
          ...state.notices,
          { id, level: event.level, message: event.message },
        ].slice(-MAX_NOTICES),
      }
    }
  }
}
