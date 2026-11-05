import type { Conversation } from '@cindl/contracts'
import { useSyncExternalStore } from 'react'

/**
 * Conversations Hermes finished in while the owner was looking elsewhere,
 * marked "Done" until opened, as T3 Code marks a thread it finished unseen.
 * Only what this session saw counts: a conversation that went from working
 * (or waiting on the owner) to idle while it was not on screen. Opening it,
 * or Hermes starting again, clears the mark. Memory only, forgotten on
 * sign-out with the rest of the session's places.
 */
let finished: ReadonlySet<string> = new Set()
const seen = new Map<string, Conversation['status']>()
const listeners = new Set<() => void>()

const busy = (status: Conversation['status'] | undefined) =>
  status === 'working' || status === 'waiting-on-you'

/** Called with every change to the conversations or to which one is on screen. */
export function noteStatuses(
  conversations: readonly Conversation[],
  onScreen: string | undefined,
): void {
  const next = new Set<string>()
  for (const conversation of conversations) {
    const before = seen.get(conversation.id)
    seen.set(conversation.id, conversation.status)
    if (conversation.id === onScreen || busy(conversation.status)) continue
    if (finished.has(conversation.id) || (conversation.status === 'idle' && busy(before)))
      next.add(conversation.id)
  }
  if (next.size === finished.size && [...next].every((id) => finished.has(id))) return
  finished = next
  for (const listener of listeners) listener()
}

export function forgetFinished(): void {
  seen.clear()
  if (!finished.size) return
  finished = new Set()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The conversations to mark "Done". */
export function useFinished(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => finished)
}
