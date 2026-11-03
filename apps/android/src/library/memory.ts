import { sha256Hex } from '@cindl/client-core'
import {
  CindlError,
  type ErrorCode,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryStore,
  type OpArgs,
  type VersionedDocument,
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
 * An entry's identity across renumbering, `<store>:<fingerprint>`: Hermes ids
 * (`memory:<store>:<index>:<fingerprint>`) carry a global index, which shifts
 * when an earlier entry is removed, and the text's fingerprint, which changes
 * only with the text.
 */
export function identityOf(id: string): string {
  const [, store, , fingerprint] = id.split(':')
  return `${store}:${fingerprint}`
}

/**
 * Kept memory drafts are filed under the entry they were written for, never
 * under a place or an index: a place can later hold another entry.
 */
export const MEMORY_DRAFT_PREFIX = 'memory-draft:'
export const memoryDraftKey = (id: string) => `${MEMORY_DRAFT_PREFIX}${identityOf(id)}`

/**
 * How an open editor relates to the entry the list shows at its place.
 * `following`: bound to the entry it read. `locked`: the place may now hold
 * another entry, so nothing is saved or deleted. `adopting`: the owner chose
 * to use the draft for the entry now here (that id); the editor stays locked
 * until that entry has been read.
 */
export type Binding = 'following' | 'locked' | { adopting: string }

export function bindingLocked(binding: Binding, readId: string | undefined): boolean {
  return (
    binding === 'locked' || (typeof binding === 'object' && readId !== binding.adopting)
  )
}

/**
 * The list now shows `listedId` at the open editor's place (undefined: the
 * entry vanished). Only the same text under a new number (an earlier entry
 * was removed) is the same entry for certain: it is read again. Any other text
 * may be this entry changed elsewhere, or another entry removed, merged or
 * added in its place, and Hermes's list cannot tell which, so the editor
 * locks. A lock is never undone here; only the owner's adoption ends it.
 */
export function followList(
  binding: Binding,
  readId: string | undefined,
  listedId: string | undefined,
  readFailed: boolean,
): { binding: Binding; reread: boolean } {
  if (bindingLocked(binding, readId)) return { binding, reread: false }
  // An adoption is complete once its entry was read; from then on it is followed.
  const current: Binding = typeof binding === 'object' ? 'following' : binding
  if (listedId === undefined) return { binding: 'locked', reread: false }
  if (readId === undefined || readId === listedId)
    return { binding: current, reread: readFailed }
  if (identityOf(readId) === identityOf(listedId))
    return { binding: current, reread: true }
  return { binding: 'locked', reread: false }
}

export const LOCKED_NOTICE =
  'The entry this editor showed was changed, removed or moved in Hermes, and Cindl cannot tell which, so nothing here can be saved or deleted. Your text is kept below to copy.'

/**
 * The last check before a write: the editor is not locked and the entry read
 * is still the version the owner reviewed. The write then names that entry's id.
 */
export function guardMemorySave(
  locked: boolean,
  readVersion: string,
  reviewedVersion: string,
): void {
  if (locked || readVersion !== reviewedVersion)
    throw new CindlError(
      'conflict',
      'This entry changed since you reviewed it. Review it again.',
    )
}

/**
 * Kept drafts whose entry Hermes no longer lists (removed, or rewritten
 * elsewhere). They are never attached to another entry: the owner copies or
 * discards them.
 */
export function orphanDrafts(
  entries: readonly MemoryEntrySummary[],
  kept: ReadonlyArray<{ key: string; draft: string }>,
): Array<{ key: string; draft: string }> {
  const listed = new Set(entries.map((entry) => identityOf(entry.id)))
  return kept.filter(
    ({ key }) =>
      key.startsWith(MEMORY_DRAFT_PREFIX) &&
      !listed.has(key.slice(MEMORY_DRAFT_PREFIX.length)),
  )
}

/**
 * The open entry vanished from the list (removed, or its store emptied): its
 * row stays, with the editor and any draft in it, until the owner closes it.
 */
export function keepsVanishedRow(
  open: MemoryPlace | undefined,
  selected: MemoryEntrySummary | undefined,
  listLoaded: boolean,
): boolean {
  return open !== undefined && selected === undefined && listLoaded
}

/** The delete confirmation names the entry it deletes. */
export function deleteWarning(title: string): string {
  return `Delete “${title}” from Hermes's memory? Hermes keeps no backup, so this cannot be undone.`
}

/**
 * The entry as the document editor shows and reviews it. The key names the
 * entry's place (the editor's label); kept drafts use memoryDraftKey instead.
 * The version is the SHA-256 of the trimmed text, whose first 12 characters
 * are the id's fingerprint.
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

export const DELETE_UNCERTAIN =
  'Cindl could not confirm the delete. Reload the list to see whether it happened.'

/** A delete refused before it took effect: changed since it was read, gone, or never sent. */
export const DELETE_REFUSED: ReadonlySet<ErrorCode> = new Set([
  ...NOT_APPLIED,
  'conflict',
  'not-found',
])
