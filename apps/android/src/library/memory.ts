import { sha256Hex } from '@cindl/client-core'
import {
  CindlError,
  isCindlError,
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
 * How the delete confirmation names an entry, and a discard control its
 * draft: the first line of the text, cut as Hermes cuts its card titles
 * (`agent/learning_graph.py`). The lock notice uses the list's own title.
 */
export function titleOf(content: string): string {
  const first = (content.trim().split('\n')[0] ?? '').replace(/^[#\s]+/, '').trim()
  return first.length > 80 ? `${first.slice(0, 80)}…` : first
}

/**
 * The entry an open editor is for (web parity: apps/web/src/library/MemoryEntries.tsx).
 * `identity` is its store and text fingerprint: the entry the owner opened,
 * then the text a save here gave it, or the entry the owner chose to use a
 * draft for. It never changes otherwise. `savedFrom` is the row's id when a
 * save here landed: until the list catches up, the row still shows the text
 * that save replaced, and it is still this entry.
 */
export interface EditorBinding {
  identity: string | undefined
  savedFrom: string | undefined
}

/** True when the row listed at the editor's place is this entry. */
export function rowIsEntry(rowId: string | undefined, binding: EditorBinding): boolean {
  return (
    rowId !== undefined &&
    (identityOf(rowId) === binding.identity || rowId === binding.savedFrom)
  )
}

/** True when the text read is this entry's. */
export function readIsEntry(
  readId: string | undefined,
  identity: string | undefined,
): boolean {
  return readId !== undefined && identityOf(readId) === identity
}

export const ANOTHER_ENTRY = 'Another entry is at this place now.'
export const REMOVED_ENTRY = 'This entry was removed in Hermes.'

/**
 * What an editor reads: only this entry, never another one at its place. A
 * refusal is the error the read reports.
 */
export function readRequest(
  rowId: string | undefined,
  rowIsIt: boolean,
): { id: string } | CindlError {
  if (rowId !== undefined && rowIsIt) return { id: rowId }
  return rowId !== undefined
    ? new CindlError('conflict', ANOTHER_ENTRY)
    : new CindlError('not-found', REMOVED_ENTRY)
}

/**
 * After the list or the read changed. The save marker is cleared once the
 * list has moved past the pre-save row. The same entry under a new number (an
 * entry was removed from the other store) is read again for its current id,
 * and a failed read is retried. Another entry at the place is never read: the
 * editor is locked instead (see `editorLocked`).
 */
export function followList(input: {
  rowId: string | undefined
  savedFrom: string | undefined
  rowIsIt: boolean
  readId: string | undefined
  readFailed: boolean
}): { clearSavedFrom: boolean; reread: boolean } {
  const clearSavedFrom = input.savedFrom !== undefined && input.rowId !== input.savedFrom
  if (input.rowId === undefined || !input.rowIsIt || input.rowId === input.savedFrom)
    return { clearSavedFrom, reread: false }
  return {
    clearSavedFrom,
    reread:
      input.readFailed || (input.readId !== undefined && input.readId !== input.rowId),
  }
}

/**
 * Locked while the list shows another entry (or none) at the place, even
 * before the first read lands, or while the text read is not this entry's.
 * Other text at the place may be this entry changed elsewhere, or another
 * entry removed, merged or added there; Hermes's list cannot tell them apart.
 * A locked editor keeps its draft, read-only, and saves or deletes nothing.
 */
export function editorLocked(rowIsIt: boolean, readIsIt: boolean): boolean {
  return !rowIsIt || !readIsIt
}

export const ADOPTION_MOVED = 'The entry at this place changed again while Cindl read it.'
export const ADOPTION_READ_FAILED = 'Cindl could not read the entry now here.'

/**
 * "Use this draft for the entry now here" reads that entry first. It completes
 * only if the text read is the target's and the target is still at the place;
 * otherwise nothing changes. The draft stays kept under the key of the entry
 * it was written for (`adoptedFrom`) until it is saved here or discarded, so
 * the target's own kept draft is never replaced. Using a draft for the entry it
 * was written for is not an adoption.
 */
export function completeAdoption(input: {
  targetId: string
  readId: string
  rowNowId: string | undefined
  from: string
}):
  | { ok: true; identity: string; adoptedFrom: string | undefined }
  | { ok: false; error: string } {
  const wanted = identityOf(input.targetId)
  if (
    identityOf(input.readId) !== wanted ||
    input.rowNowId === undefined ||
    identityOf(input.rowNowId) !== wanted
  )
    return { ok: false, error: ADOPTION_MOVED }
  return {
    ok: true,
    identity: wanted,
    adoptedFrom:
      input.from === `${MEMORY_DRAFT_PREFIX}${wanted}` ? undefined : input.from,
  }
}

/**
 * The adoption's read and its check. `rowNow` is asked once the read has
 * answered: the place may have changed while it was out. A failed read is
 * reported; nothing changes either way until the caller applies an `ok`.
 */
export async function readForAdoption(input: {
  read: (args: { id: string }) => Promise<MemoryEntry>
  target: MemoryEntrySummary
  from: string
  rowNow: () => MemoryEntrySummary | undefined
}): Promise<
  | { ok: true; read: MemoryEntry; identity: string; adoptedFrom: string | undefined }
  | { ok: false; error: string }
> {
  let read: MemoryEntry
  try {
    read = await input.read({ id: input.target.id })
  } catch (failure) {
    return {
      ok: false,
      error: isCindlError(failure) ? failure.message : ADOPTION_READ_FAILED,
    }
  }
  const outcome = completeAdoption({
    targetId: input.target.id,
    readId: read.id,
    rowNowId: input.rowNow()?.id,
    from: input.from,
  })
  return outcome.ok ? { ...outcome, read } : outcome
}

/**
 * After a save here: the saved text is this entry, and the row it was saved
 * from still counts as this entry until the list catches up.
 */
export function bindingAfterSave(
  savedId: string,
  rowId: string | undefined,
): EditorBinding {
  return { identity: identityOf(savedId), savedFrom: rowId }
}

/** Where kept drafts of this editor go: a used draft's own key, else this entry's. */
export function editorDraftKey(
  adoptedFrom: string | undefined,
  identity: string | undefined,
): string | undefined {
  return (
    adoptedFrom ??
    (identity === undefined ? undefined : `${MEMORY_DRAFT_PREFIX}${identity}`)
  )
}

/**
 * Where the entry with this identity is listed now (1-based in its store),
 * when exactly one entry has that text.
 */
export function placeNow(
  entries: readonly MemoryEntrySummary[],
  identity: string | undefined,
): number | undefined {
  if (identity === undefined) return undefined
  const [store] = identity.split(':')
  const places = entries
    .filter((entry) => entry.store === store)
    .flatMap((entry, index) => (identityOf(entry.id) === identity ? [index + 1] : []))
  return places.length === 1 ? places[0] : undefined
}

export const LOCKED_NOTICE =
  'The entry this editor showed was changed, removed or moved in Hermes, and Cindl cannot tell which, so nothing here can be saved or deleted. Your text is kept below to copy.'

/** The lock notice: where the same text is now, and which entry is at this place. */
export function lockNotice(input: {
  /** "agent note" or "note about you". */
  noun: string
  place: number
  movedTo: number | undefined
  nowTitle: string | undefined
}): string {
  const moved =
    input.movedTo !== undefined && input.movedTo !== input.place
      ? ` The same text is now ${input.noun} ${input.movedTo}; close this and open it there to keep editing it.`
      : ''
  const now =
    input.nowTitle !== undefined ? ` Now at this place: “${input.nowTitle}”.` : ''
  return `${LOCKED_NOTICE}${moved}${now}`
}

/** Said above a draft used for the entry now here. */
export function adoptedDraftNote(ownDraftKept: boolean): string {
  return `This draft was written for the entry that was here before. Review it against this entry's text before saving; until you save or discard it, it stays kept for that entry.${
    ownDraftKept
      ? ' This entry also has an unsaved draft of its own, which stays kept.'
      : ''
  }`
}

/** Each discard control names its draft, so TalkBack users can tell them apart. */
export const discardDraftLabel = (draft: string) => `Discard draft: ${titleOf(draft)}`

/** The row of an open entry that is no longer listed at its place. */
export const NO_LONGER_HERE = 'No longer at this place'
export const CLOSE_NO_LONGER_HERE = 'Close the entry no longer at this place'

/** What an open memory editor shows and allows (`entryEditorView`). */
export interface EntryEditorView {
  /** The row listed at the place is this entry. */
  rowIsIt: boolean
  /** Nothing can be saved or deleted (`editorLocked`). */
  locked: boolean
  /** Where this entry's own drafts are kept. */
  ownKey: string | undefined
  /** Where the draft being edited is kept: a used draft's own key, else `ownKey`. */
  draftKey: string | undefined
  /** Why nothing can be saved, when locked. */
  lockNotice: string | undefined
  /** The entry "Use this draft for the entry now here" would use the draft for. */
  adoptTarget: MemoryEntrySummary | undefined
  /** Said above a used draft. */
  draftNote: string | undefined
  /** Keep the draft while it is edited: a used draft stays kept for its own entry. */
  keepDraft: boolean
  /** What "Delete entry…" deletes, named by the text read under that id. */
  deletes: { entry: MemoryEntry; title: string } | undefined
}

/**
 * An open editor, from the entry it is bound to, the row listed at its place
 * and the text it read (MemoryEntries.tsx renders it as it is; tests drive it
 * without React Native).
 */
export function entryEditorView(input: {
  binding: EditorBinding
  adoptedFrom: string | undefined
  row: MemoryEntrySummary | undefined
  read: MemoryEntry | undefined
  store: MemoryStore
  /** 1-based place in its store. */
  place: number
  /** Where an identity is listed now (`placeNow`). */
  placeNow: (identity: string | undefined) => number | undefined
  /** Whether a draft is kept under a key. */
  kept: (key: string) => boolean
}): EntryEditorView {
  const { binding, adoptedFrom, row, read } = input
  const rowIsIt = rowIsEntry(row?.id, binding)
  const locked = editorLocked(rowIsIt, readIsEntry(read?.id, binding.identity))
  const ownKey = editorDraftKey(undefined, binding.identity)
  const store = read?.store ?? row?.store ?? input.store
  const noun = memoryStores.find((entry) => entry.store === store)?.noun ?? 'entry'
  return {
    rowIsIt,
    locked,
    ownKey,
    draftKey: editorDraftKey(adoptedFrom, binding.identity),
    lockNotice: locked
      ? lockNotice({
          noun,
          place: input.place,
          movedTo: input.placeNow(binding.identity),
          nowTitle: row?.title,
        })
      : undefined,
    adoptTarget: locked ? row : undefined,
    draftNote:
      adoptedFrom === undefined
        ? undefined
        : adoptedDraftNote(ownKey !== undefined && input.kept(ownKey)),
    keepDraft: adoptedFrom !== undefined,
    deletes: !locked && read ? { entry: read, title: titleOf(read.content) } : undefined,
  }
}

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
