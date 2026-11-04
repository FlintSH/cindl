import { useSyncExternalStore } from 'react'

/** The working margin's tools (ADR 0013). */
export type MarginTool = 'waiting' | 'step' | 'computer'

/**
 * Where the owner left each conversation on this page: the message being
 * written, how far back they were reading, the selected step and the working
 * margin's tool. It survives switching conversations and views, so nothing
 * jumps away mid-task. Memory only, like every draft: it is forgotten when the
 * session ends.
 */
export interface Place {
  /** The unsent message. */
  readonly draft: string
  /** Where the owner scrolled back to read; undefined while following the newest. */
  readonly scrollTop: number | undefined
  /** The selected step. */
  readonly toolId: string | undefined
  /** The margin's tool the owner chose here; undefined until they choose one. */
  readonly tool: MarginTool | undefined
}

const nowhere: Place = {
  draft: '',
  scrollTop: undefined,
  toolId: undefined,
  tool: undefined,
}
const places = new Map<string, Place>()
const listeners = new Set<() => void>()

export const placeOf = (conversationId: string): Place =>
  places.get(conversationId) ?? nowhere

export function keepPlace(conversationId: string, change: Partial<Place>) {
  const place = { ...placeOf(conversationId), ...change }
  if (
    place.draft ||
    place.scrollTop !== undefined ||
    place.toolId !== undefined ||
    place.tool !== undefined
  )
    places.set(conversationId, place)
  else places.delete(conversationId)
  for (const listener of listeners) listener()
}

// The owner switched conversations from the switcher: the conversation that
// opens puts focus back on its switcher, which the old one took with it.
let switched = false

export function noteSwitch() {
  switched = true
}

/** Whether the conversation now opening came from the switcher (asked once). */
export function takeSwitch(): boolean {
  const was = switched
  switched = false
  return was
}

/** The session ended: nothing typed or read on this device outlives it. */
export function forgetPlaces() {
  places.clear()
  for (const listener of listeners) listener()
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
 * The margin's tool for a conversation: the one the owner chose there, else
 * Step while a step is selected, else Waiting.
 */
export function useMarginTool(conversationId: string | undefined): MarginTool {
  return useSyncExternalStore(subscribe, () => {
    if (!conversationId) return 'waiting'
    const place = placeOf(conversationId)
    return place.tool ?? (place.toolId ? 'step' : 'waiting')
  })
}
