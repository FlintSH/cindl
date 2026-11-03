import type { ServerRequest, ToolActivity } from '@cindl/contracts'
import { entry } from './records.ts'
import { selectOpenRequests } from './selectors.ts'
import type { ClientState } from './state.ts'

/**
 * What a conversation is actually doing, derived only from state Cindl has
 * observed. Precedence: an open request means Hermes is blocked on the owner,
 * so nothing is shown as computing even if a tool call is still open.
 */
export type ConversationPhase =
  'waiting-on-you' | 'executing' | 'queued' | 'idle' | 'unknown'

export interface ConversationActivity {
  phase: ConversationPhase
  openRequests: ServerRequest[]
  /** Tool steps actively executing (not blocked on the owner). */
  executingTools: ToolActivity[]
  /** Open tool steps that are paused because the owner must answer a request. */
  blockedToolIds: ReadonlySet<string>
  /** Prompts Hermes accepted but has not started (disposition `queued`). */
  queuedPrompts: number
  /** A turn is open (streaming message), whatever its phase. */
  turnOpen: boolean
  /** Other conversations this client knows are executing. */
  otherExecuting: number
}

const isOpenTool = (t: ToolActivity) =>
  t.status === 'running' || t.status === 'generating'

export function selectConversationActivity(
  state: ClientState,
  conversationId: string | undefined,
): ConversationActivity {
  if (!conversationId)
    return {
      phase: 'unknown',
      openRequests: [],
      executingTools: [],
      blockedToolIds: new Set(),
      queuedPrompts: 0,
      turnOpen: false,
      otherExecuting: 0,
    }
  const openRequests = selectOpenRequests(state, conversationId)
  const openTools = Object.values(state.tools).filter(
    (t) => t.conversationId === conversationId && isOpenTool(t),
  )
  const blocked = openRequests.length > 0
  const queuedPrompts = Object.values(state.prompts).filter(
    (p) =>
      p.conversationId === conversationId &&
      p.state === 'accepted' &&
      p.disposition === 'queued',
  ).length
  const turnOpen = (entry(state.messages, conversationId) ?? []).some(
    (m) => m.status === 'streaming',
  )
  const conversation = entry(state.conversations, conversationId)
  const otherExecuting = Object.values(state.conversations).filter(
    (c) => c.id !== conversationId && c.status === 'working',
  ).length
  const phase: ConversationPhase = blocked
    ? 'waiting-on-you'
    : openTools.length || (turnOpen && conversation?.status === 'working')
      ? 'executing'
      : queuedPrompts
        ? 'queued'
        : conversation?.status === 'working'
          ? 'executing'
          : conversation?.status === 'unknown' || !conversation
            ? 'unknown'
            : 'idle'
  return {
    phase,
    openRequests,
    executingTools: blocked ? [] : openTools,
    blockedToolIds: new Set(blocked ? openTools.map((t) => t.id) : []),
    queuedPrompts,
    turnOpen,
    otherExecuting,
  }
}
