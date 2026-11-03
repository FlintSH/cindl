import { sha256Hex } from '@cindl/client-core'
import type {
  ErrorCode,
  MemoryEntry,
  MemoryEntrySummary,
  MemoryStore,
  OpArgs,
  VersionedDocument,
} from '@cindl/contracts'
import { NOT_APPLIED } from '../talk/failures.ts'

/**
 * Hermes's memory entries (web parity: apps/web/src/library/MemoryEntries.tsx).
 * Every write and delete names the fingerprinted id of the entry that was read
 * and reviewed, exactly as Hermes listed it, so Hermes refuses it if the entry
 * changed since. Cindl never builds an id itself.
 */
export const memoryStores: ReadonlyArray<{
  store: MemoryStore
  title: string
  hint: string
  noun: string
}> = [
  {
    store: 'memory',
    title: 'Agent notes',
    hint: 'What Hermes noted for itself.',
    noun: 'agent note',
  },
  {
    store: 'profile',
    title: 'About you',
    hint: 'What Hermes keeps about you.',
    noun: 'note about you',
  },
]

/** Where an entry sits in the list. The screen follows it across edits; writes never use it. */
export interface MemoryPlace {
  store: MemoryStore
  index: number
}

export function placeOf(
  entries: readonly MemoryEntrySummary[],
  id: string,
): MemoryPlace | undefined {
  const entry = entries.find((candidate) => candidate.id === id)
  if (!entry) return undefined
  return {
    store: entry.store,
    index: entries.filter((other) => other.store === entry.store).indexOf(entry),
  }
}

export function entryAt(
  entries: readonly MemoryEntrySummary[],
  place: MemoryPlace,
): MemoryEntrySummary | undefined {
  return entries.filter((entry) => entry.store === place.store)[place.index]
}

/**
 * "agent note 2": the entry's 1-based place in its store. Not the id's index:
 * Hermes numbers entries across both stores.
 */
export function memoryEntryName(store: MemoryStore, place: number): string {
  const noun = memoryStores.find((entry) => entry.store === store)?.noun ?? 'entry'
  return `${noun} ${place}`
}

/**
 * The entry as the document editor shows and reviews it. The key names the
 * entry's place, so a draft kept after a conflict comes back once the entry is
 * read again under its new id. The version is the SHA-256 of the trimmed text,
 * whose first 12 characters are the id's fingerprint.
 */
export function memoryDocument(entry: MemoryEntry, place: number): VersionedDocument {
  return {
    key: memoryEntryName(entry.store, place),
    content: entry.content,
    version: sha256Hex(entry.content.trim()),
    readAt: entry.readAt,
    source: entry.source,
  }
}

/** Replace the entry that was read and reviewed: its id is its version. */
export function memoryWrite(
  read: Pick<MemoryEntry, 'id'>,
  content: string,
): OpArgs<'memory.write'> {
  return { id: read.id, content, confirm: true }
}

/** Delete the entry that was read, after the owner was warned it is permanent. */
export function memoryDelete(read: Pick<MemoryEntry, 'id'>): OpArgs<'memory.delete'> {
  return { id: read.id, confirm: true }
}

export const DELETE_WARNING =
  "Delete this entry from Hermes's memory? Hermes keeps no backup, so this cannot be undone."

export const DELETE_UNCERTAIN =
  'Cindl could not confirm the delete. Reload the list to see whether it happened.'

/** A delete refused before it took effect: changed since it was read, gone, or never sent. */
export const DELETE_REFUSED: ReadonlySet<ErrorCode> = new Set([
  ...NOT_APPLIED,
  'conflict',
  'not-found',
])
