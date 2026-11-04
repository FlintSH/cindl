import { useSyncExternalStore } from 'react'

/** The working margin's tools: the conversation's panel (ADR 0013). */
export type MarginTool = 'waiting' | 'step' | 'computer'

/**
 * Where the owner left each conversation (web parity: apps/web/src/talk/places.ts):
 * the message being written, how far back they were reading, the selected step
 * and the working margin's tool. It survives switching conversations and
 * destinations, so nothing jumps away mid-task. Memory only, like every draft:
 * it is forgotten when the session ends (shell/sessionDrafts.ts).
 */
export interface Place {
  /** The unsent message. */
  readonly draft: string
  /** Where the owner scrolled back to read (dp from the top); undefined while following the newest. */
  readonly scrollY: number | undefined
  /** The selected step. */
  readonly toolId: string | undefined
  /** The margin's tool the owner chose here; undefined until they choose one. */
  readonly tool: MarginTool | undefined
}

const nowhere: Place = {
  draft: '',
  scrollY: undefined,
  toolId: undefined,
  tool: undefined,
}
const places = new Map<string, Place>()
const listeners = new Set<() => void>()

export const placeOf = (conversationId: string): Place =>
  places.get(conversationId) ?? nowhere

export function keepPlace(conversationId: string, change: Partial<Place>): void {
  const place = { ...placeOf(conversationId), ...change }
  if (
    place.draft ||
    place.scrollY !== undefined ||
    place.toolId !== undefined ||
    place.tool !== undefined
  )
    places.set(conversationId, place)
  else places.delete(conversationId)
  for (const listener of [...listeners]) listener()
}

/** The session ended: nothing typed or read on this device outlives it. */
export function forgetPlaces(): void {
  places.clear()
  for (const listener of [...listeners]) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The selected step of a conversation, kept current wherever it is shown. */
export function useSelectedStep(conversationId: string | undefined): string | undefined {
  return useSyncExternalStore(subscribe, () =>
    conversationId ? placeOf(conversationId).toolId : undefined,
  )
}

/**
 * The margin's tool for a conversation: the one chosen there (selecting a step
 * chooses Step, TalkView), else Waiting. Nothing else changes it: a new
 * request changes Waiting's count, not the tool.
 */
export function useMarginTool(conversationId: string | undefined): MarginTool {
  return useSyncExternalStore(subscribe, () =>
    conversationId ? (placeOf(conversationId).tool ?? 'waiting') : 'waiting',
  )
}
