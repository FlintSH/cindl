import type { Conversation, ServerRequest } from '@cindl/contracts'
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

/**
 * A row's right-hand slot, after T3 Code's thread status: what the owner must
 * answer, then what is working, then what finished while they looked
 * elsewhere, then how long ago it changed. `spoken` is what a screen reader
 * hears in place of the short form ("5 minutes ago" for "5m").
 */
export type RowStatus =
  | { kind: 'approval' | 'question' | 'needs-you'; label: string; spoken?: string }
  | { kind: 'working' | 'done'; label: string; spoken?: string }
  | { kind: 'time'; label: string; spoken: string }
  | { kind: 'none'; label: string; spoken?: string }

export interface RowFacts {
  /** This conversation's open requests, by kind. */
  requests?: readonly Pick<ServerRequest, 'kind'>[]
  /** Hermes finished it while the owner was elsewhere (finished.ts). */
  finished?: boolean
}

export function rowStatus(
  conversation: Conversation,
  now = Date.now(),
  { requests = [], finished = false }: RowFacts = {},
): RowStatus {
  const approvals = requests.filter((r) => r.kind === 'approval').length
  const questions = requests.filter((r) => r.kind === 'clarify').length
  if (requests.length > 1)
    return {
      kind: approvals ? 'approval' : questions ? 'question' : 'needs-you',
      label: `${requests.length} need you`,
    }
  if (approvals) return { kind: 'approval', label: 'Approval' }
  if (questions) return { kind: 'question', label: 'Question' }
  if (requests.length || conversation.status === 'waiting-on-you')
    return { kind: 'needs-you', label: 'Needs you' }
  if (conversation.status === 'working') return { kind: 'working', label: 'Working' }
  if (finished) return { kind: 'done', label: 'Done', spoken: 'Done, not seen yet' }
  const ago = shortAgo(conversation.updatedAt, now)
  return ago
    ? { kind: 'time', label: ago, spoken: longAgo(conversation.updatedAt, now) ?? ago }
    : { kind: 'none', label: '' }
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

/** The same age as a screen reader should say it: "5 minutes ago", "June 2". */
export function longAgo(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return undefined
  const minutes = Math.floor((now - then) / 60_000)
  const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (minutes < 1) return 'just now'
  if (minutes < 60) return ago(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return ago(hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 7) return ago(days, 'day')
  const date = new Date(then)
  return date.toLocaleDateString(
    [],
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'long', day: 'numeric' }
      : { month: 'long', day: 'numeric', year: 'numeric' },
  )
}

/** The whole list in keyboard order, for the arrow keys. */
export const flatten = (shelves: readonly Shelf[]): Conversation[] =>
  shelves.flatMap((shelf) => shelf.conversations)
