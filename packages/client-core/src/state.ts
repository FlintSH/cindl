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

export interface Notice {
  id: number
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface ClientState {
  link: LinkState
  capabilities: CapabilityMap
  conversations: Readonly<Record<string, Conversation>>
  messages: Readonly<Record<string, readonly Message[]>>
  tools: Readonly<Record<string, ToolActivity>>
  prompts: Readonly<Record<string, PendingPrompt>>
  /** Keyed by `requestKey(rpcId, connectionEpoch)`. */
  requests: Readonly<Record<string, ServerRequest>>
  usage: Readonly<Record<string, Usage>>
  display: DisplayState | undefined
  notices: readonly Notice[]
}

export function initialState(link: LinkState): ClientState {
  return {
    link,
    capabilities: {},
    conversations: {},
    messages: {},
    tools: {},
    prompts: {},
    requests: {},
    usage: {},
    display: undefined,
    notices: [],
  }
}

export const requestKey = (rpcId: string | number, connectionEpoch: number) =>
  `${connectionEpoch}:${typeof rpcId}:${rpcId}`

const MAX_NOTICES = 20

function patchMessages(
  state: ClientState,
  conversationId: string,
  update: (messages: readonly Message[]) => readonly Message[],
): ClientState {
  const current = state.messages[conversationId] ?? []
  const next = update(current)
  return next === current
    ? state
    : { ...state, messages: { ...state.messages, [conversationId]: next } }
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
        conversations: {
          ...state.conversations,
          [event.conversation.id]: event.conversation,
        },
      }
    case 'conversation.removed': {
      const { [event.conversationId]: _removed, ...conversations } = state.conversations
      const { [event.conversationId]: _messages, ...messages } = state.messages
      return { ...state, conversations, messages }
    }
    case 'history.loaded':
      return {
        ...state,
        messages: { ...state.messages, [event.conversationId]: event.messages },
      }
    case 'history.reset': {
      const { [event.conversationId]: _dropped, ...messages } = state.messages
      return { ...state, messages }
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
        if (index < 0) return messages
        const message = messages[index] as Message
        const parts =
          event.text === undefined
            ? message.parts
            : [
                ...message.parts.filter((part) => part.type !== 'text'),
                { type: 'text' as const, text: event.text },
              ]
        const next = [...messages]
        next[index] = { ...message, parts, status: event.status }
        return next
      })
    case 'tool.updated': {
      const { activity } = event
      const known = activity.id in state.tools
      const withTool = { ...state, tools: { ...state.tools, [activity.id]: activity } }
      if (known) return withTool
      // Anchor a new tool in the conversation's streaming assistant message so it renders in order.
      return patchMessages(withTool, activity.conversationId, (messages) => {
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
        prompts: { ...state.prompts, [event.prompt.clientId]: event.prompt },
      }
    case 'request.opened': {
      const key = requestKey(event.request.rpcId, event.request.connectionEpoch)
      const existing = state.requests[key]
      // A replayed frame never resurrects a request this client already answered or closed.
      if (existing && existing.status !== 'open') return state
      return { ...state, requests: { ...state.requests, [key]: event.request } }
    }
    case 'request.closed': {
      const matches = Object.entries(state.requests).filter(
        ([, r]) => r.rpcId === event.rpcId,
      )
      if (!matches.length) return state
      const requests = { ...state.requests }
      for (const [key, request] of matches)
        if (request.status === 'open' || request.status === 'answering')
          requests[key] = { ...request, status: event.status }
      return { ...state, requests }
    }
    case 'session.status': {
      const conversation = state.conversations[event.conversationId]
      if (!conversation || conversation.status === event.status) return state
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [event.conversationId]: { ...conversation, status: event.status },
        },
      }
    }
    case 'usage.updated':
      return { ...state, usage: { ...state.usage, [event.conversationId]: event.usage } }
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
