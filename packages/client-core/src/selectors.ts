import {
  capabilityUsable,
  type CapabilityId,
  type Conversation,
  type ServerRequest,
} from '@cindl/contracts'
import type { ClientState } from './state.ts'

const byRecent = (a: Conversation, b: Conversation) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.title.localeCompare(b.title)

export function selectConversations(state: ClientState): Conversation[] {
  return Object.values(state.conversations)
    .filter((c) => !c.archived)
    .sort((a, b) => (a.kind === b.kind ? byRecent(a, b) : a.kind === 'main' ? -1 : 1))
}

export function selectMainConversation(state: ClientState): Conversation | undefined {
  return Object.values(state.conversations).find((c) => c.kind === 'main')
}

/** Requests the owner can still act on, oldest first. */
export function selectOpenRequests(
  state: ClientState,
  conversationId?: string,
): ServerRequest[] {
  return Object.values(state.requests)
    .filter((r) => r.status === 'open' || r.status === 'answering')
    .filter((r) => conversationId === undefined || r.conversationId === conversationId)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
}

export function selectWorkingConversations(state: ClientState): Conversation[] {
  return Object.values(state.conversations).filter(
    (c) => c.status === 'working' || c.status === 'waiting-on-you',
  )
}

export function selectUncertainPrompts(state: ClientState) {
  return Object.values(state.prompts).filter((p) => p.state === 'uncertain')
}

export function selectCan(state: ClientState, id: CapabilityId): boolean {
  return capabilityUsable(state.capabilities[id])
}
