/**
 * Where the owner left each conversation on this page: the message being
 * written, how far back they were reading and the step whose evidence the
 * working margin shows. It survives switching conversations and views, so
 * nothing jumps away mid-task. Memory only, like every draft: it is forgotten
 * when the session ends.
 */
export interface Place {
  /** The unsent message. */
  readonly draft: string
  /** Where the owner scrolled back to read; undefined while following the newest. */
  readonly scrollTop: number | undefined
  /** The selected step. */
  readonly toolId: string | undefined
}

const nowhere: Place = { draft: '', scrollTop: undefined, toolId: undefined }
const places = new Map<string, Place>()

export const placeOf = (conversationId: string): Place =>
  places.get(conversationId) ?? nowhere

export function keepPlace(conversationId: string, change: Partial<Place>) {
  const place = { ...placeOf(conversationId), ...change }
  if (place.draft || place.scrollTop !== undefined || place.toolId !== undefined)
    places.set(conversationId, place)
  else places.delete(conversationId)
}

/** The session ended: nothing typed or read on this device outlives it. */
export function forgetPlaces() {
  places.clear()
}
