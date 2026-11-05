import { entry } from '@cindl/client-core'
import { useCindlState } from '@cindl/client-react'
import type { Conversation, Message } from '@cindl/contracts'
import { useMemo, useSyncExternalStore } from 'react'

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

/** How a turn that finished unseen ended, as far as this client saw. */
export type Outcome = 'done' | 'failed' | 'stopped'

/**
 * A reply that ended in an error reads "Failed", one stopped part way
 * "Stopped". Otherwise, including a reply this client never saw, "Done":
 * Hermes finished the turn.
 */
export function outcomeOf(
  messages: readonly Pick<Message, 'role' | 'status'>[] | undefined,
): Outcome {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages?.[index]
    if (message?.role !== 'assistant') continue
    return message.status === 'error'
      ? 'failed'
      : message.status === 'interrupted'
        ? 'stopped'
        : 'done'
  }
  return 'done'
}

/** The conversations to mark, each with how its turn ended. */
export function useFinishedOutcomes(): ReadonlyMap<string, Outcome> {
  const ids = useFinished()
  // One string, so the snapshot stays stable between unrelated changes.
  const key = useCindlState((state) =>
    [...ids]
      .map((id) => `${id}\u0000${outcomeOf(entry(state.messages, id))}`)
      .join('\u0001'),
  )
  return useMemo(
    () =>
      new Map(
        key
          ? key.split('\u0001').map((row) => {
              const [id = '', outcome = 'done'] = row.split('\u0000')
              return [id, outcome as Outcome] as const
            })
          : [],
      ),
    [key],
  )
}
