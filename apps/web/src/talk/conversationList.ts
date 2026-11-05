import type { Conversation } from '@cindl/contracts'
import { fuzzyScore } from '../shell/CommandPalette.tsx'

/**
 * The conversation list beside Talk (after T3 Code's thread sidebar): the
 * main conversation pinned, then what needs the owner, then the rest by
 * recency, as client-core orders them. A row's right-hand slot shows its
 * status when it has one worth a glance, else how long ago it changed.
 */
export interface Shelf {
  id: 'pinned' | 'needs-you' | 'recent'
  label: string
  conversations: Conversation[]
}

export function shelvesOf(conversations: readonly Conversation[], query = ''): Shelf[] {
  const matching = query.trim()
    ? conversations.filter(
        (c) => fuzzyScore(query, `${c.title} ${c.preview ?? ''}`) !== undefined,
      )
    : conversations
  const pinned = matching.filter((c) => c.kind === 'main')
  const needsYou = matching.filter(
    (c) => c.kind !== 'main' && c.status === 'waiting-on-you',
  )
  const recent = matching.filter(
    (c) => c.kind !== 'main' && c.status !== 'waiting-on-you',
  )
  const shelves: Shelf[] = [
    { id: 'pinned', label: 'Pinned', conversations: pinned },
    { id: 'needs-you', label: 'Needs you', conversations: needsYou },
    { id: 'recent', label: 'Recent', conversations: recent },
  ]
  return shelves.filter((shelf) => shelf.conversations.length > 0)
}

export type RowStatus =
  | { kind: 'needs-you'; label: string }
  | { kind: 'working'; label: string }
  | { kind: 'time'; label: string }
  | { kind: 'none'; label: string }

/** Status outranks time: what needs the owner, then what is working, then when. */
export function rowStatus(conversation: Conversation, now = Date.now()): RowStatus {
  if (conversation.status === 'waiting-on-you')
    return { kind: 'needs-you', label: 'Needs you' }
  if (conversation.status === 'working') return { kind: 'working', label: 'Working' }
  const ago = shortAgo(conversation.updatedAt, now)
  return ago ? { kind: 'time', label: ago } : { kind: 'none', label: '' }
}

/**
 * How long ago, as a list writes it: "now", "5m", "3h", "2d", then the date
 * ("Jun 2", with the year when it is another year's). A time ahead of this
 * clock reads "now" rather than a negative age.
 */
export function shortAgo(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return undefined
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const date = new Date(then)
  return date.toLocaleDateString(
    [],
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  )
}

/** The whole list in keyboard order, for the arrow keys. */
export const flatten = (shelves: readonly Shelf[]): Conversation[] =>
  shelves.flatMap((shelf) => shelf.conversations)
