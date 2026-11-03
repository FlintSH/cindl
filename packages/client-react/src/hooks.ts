import {
  selectCan,
  selectConversationActivity,
  type ConversationActivity,
  selectConversations,
  selectMainConversation,
  selectOpenRequests,
  selectUncertainPrompts,
  type ClientState,
} from '@cindl/client-core'
import type {
  CapabilityId,
  Conversation,
  Message,
  PendingPrompt,
  ServerRequest,
} from '@cindl/contracts'
import { useCallback, useRef } from 'react'
import { useCindlState } from './provider.tsx'

/** Memoise a derived array so useSyncExternalStore sees a stable snapshot. */
function useStableArray<T>(selector: (state: ClientState) => T[]): T[] {
  const cache = useRef<{ source: unknown; value: T[] } | null>(null)
  const select = useCallback(
    (state: ClientState) => {
      const value = selector(state)
      const previous = cache.current
      if (
        previous &&
        previous.value.length === value.length &&
        previous.value.every((v, i) => v === value[i])
      )
        return previous.value
      cache.current = { source: state, value }
      return value
    },
    [selector],
  )
  return useCindlState(select)
}

export const useLink = () => useCindlState((state) => state.link)
export const useCapability = (id: CapabilityId) =>
  useCindlState((state) => state.capabilities[id])
export const useCan = (id: CapabilityId) => useCindlState((state) => selectCan(state, id))
export const useConversations = (): Conversation[] => useStableArray(selectConversations)
export const useMainConversation = () => useCindlState(selectMainConversation)
export const useConversation = (id: string | undefined) =>
  useCindlState((state) => (id ? state.conversations[id] : undefined))

const empty: readonly Message[] = []
export const useMessages = (conversationId: string | undefined) =>
  useCindlState((state) =>
    conversationId ? (state.messages[conversationId] ?? empty) : empty,
  )
export const useTool = (id: string) => useCindlState((state) => state.tools[id])

export function useUncertainPrompts(conversationId: string | undefined): PendingPrompt[] {
  const selector = useCallback(
    (state: ClientState) =>
      selectUncertainPrompts(state).filter(
        (prompt) => prompt.conversationId === conversationId,
      ),
    [conversationId],
  )
  return useStableArray(selector)
}

export function useOpenRequests(conversationId?: string): ServerRequest[] {
  const selector = useCallback(
    (state: ClientState) => selectOpenRequests(state, conversationId),
    [conversationId],
  )
  return useStableArray(selector)
}

const sameItems = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])

function sameActivity(a: ConversationActivity, b: ConversationActivity) {
  return (
    a.phase === b.phase &&
    a.queuedPrompts === b.queuedPrompts &&
    a.turnOpen === b.turnOpen &&
    a.otherExecuting === b.otherExecuting &&
    sameItems(a.openRequests, b.openRequests) &&
    sameItems(a.executingTools, b.executingTools) &&
    sameItems([...a.blockedToolIds], [...b.blockedToolIds])
  )
}

/** Derived activity for one conversation, stable across unrelated state changes. */
export function useConversationActivity(
  conversationId: string | undefined,
): ConversationActivity {
  const cache = useRef<{ id: string | undefined; value: ConversationActivity } | null>(
    null,
  )
  const select = useCallback(
    (state: ClientState) => {
      const value = selectConversationActivity(state, conversationId)
      const previous = cache.current
      if (
        previous &&
        previous.id === conversationId &&
        sameActivity(previous.value, value)
      )
        return previous.value
      cache.current = { id: conversationId, value }
      return value
    },
    [conversationId],
  )
  return useCindlState(select)
}
