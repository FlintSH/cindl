import { sha256Hex } from '@cindl/client-core'
import { useCan, useCindlApi } from '@cindl/client-react'
import {
  CindlError,
  isCindlError,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryStore,
  type VersionedDocument,
} from '@cindl/contracts'
import { useEffect, useEffectEvent, useState } from 'react'
import { Button, SectionTitle } from '../ui/primitives.tsx'
import {
  DocumentEditor,
  forgetDocumentDraft,
  keptDocumentDrafts,
} from '../views/DocumentEditor.tsx'
import { useResource } from '../views/useResource.ts'
import styles from '../views/views.module.css'

const stores: Array<{ store: MemoryStore; title: string; hint: string }> = [
  { store: 'memory', title: 'Agent notes', hint: 'What Hermes noted for itself.' },
  { store: 'profile', title: 'About you', hint: 'What Hermes keeps about you.' },
]

/**
 * An entry's identity across renumbering: Hermes ids carry the global index,
 * which shifts when an earlier entry is removed, and the text's fingerprint,
 * which only changes with the text.
 */
const fingerprintOf = (id: string) => {
  const [, store, , fingerprint] = id.split(':')
  return `${store}:${fingerprint}`
}

/** Kept memory drafts are filed under the entry they were written for. */
const MEMORY_DRAFT_PREFIX = 'memory-draft:'

/** Where an entry sits in the list. The UI follows it across edits; writes never use it. */
interface Position {
  store: MemoryStore
  index: number
}
const positionOf = (entries: MemoryEntrySummary[], id: string): Position | undefined => {
  const entry = entries.find((e) => e.id === id)
  if (!entry) return undefined
  return {
    store: entry.store,
    index: entries.filter((e) => e.store === entry.store).indexOf(entry),
  }
}
const atPosition = (entries: MemoryEntrySummary[], at: Position) =>
  entries.filter((e) => e.store === at.store)[at.index]

/**
 * Hermes's memory entries, editable one at a time. Every write and delete
 * names the entry's current fingerprinted id, so Hermes refuses it if the
 * entry changed after it was read. Deleting is permanent.
 */
export function MemoryEntries() {
  const api = useCindlApi()
  const list = useResource(
    () => api.call('memory.entries', {}),
    'memory-entries',
    'Memory entries could not be loaded.',
  )
  const [open, setOpen] = useState<Position>()
  const [, setDraftsSeen] = useState(0)
  const entries = list.data ?? []
  const selected = open ? atPosition(entries, open) : undefined
  // Drafts kept for entries Hermes no longer lists (removed, or rewritten
  // elsewhere). They never attach to another entry; the owner copies or
  // discards them. Shown while no entry is open, which also keeps a locked
  // editor's draft from appearing twice.
  const listed = new Set(entries.map((entry) => fingerprintOf(entry.id)))
  const orphans =
    open || !list.data
      ? []
      : keptDocumentDrafts(MEMORY_DRAFT_PREFIX).filter(
          ({ key }) => !listed.has(key.slice(MEMORY_DRAFT_PREFIX.length)),
        )
  const editor = (summary: MemoryEntrySummary | undefined, place: number) => (
    <MemoryEntryEditor
      summary={summary}
      place={place}
      onChanged={list.reload}
      onDeleted={() => {
        setOpen(undefined)
        list.reload()
      }}
    />
  )
  return (
    <section className={styles.section} aria-labelledby="memory-entries-title">
      <SectionTitle id="memory-entries-title">Entries</SectionTitle>
      {list.error ? <p className={styles.error}>{list.error}</p> : null}
      {list.data && !entries.length ? (
        <p className={styles.note}>Hermes has no memory entries yet.</p>
      ) : null}
      {orphans.length ? (
        <div className={styles.memoryStore}>
          <h3 className={styles.memoryStoreTitle}>Unsaved drafts</h3>
          <p className={styles.note}>
            Text you wrote for entries Hermes no longer lists (removed, or changed
            elsewhere). Copy what you need; nothing here is saved.
          </p>
          <ul className={styles.rows}>
            {orphans.map(({ key, draft }) => (
              <li key={key} className={styles.memoryItem}>
                <pre className={styles.doc}>{draft}</pre>
                <div className={styles.actions}>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      forgetDocumentDraft(key)
                      setDraftsSeen((value) => value + 1)
                    }}
                  >
                    Discard draft
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {stores.map(({ store, title, hint }) => {
        const inStore = entries.filter((entry) => entry.store === store)
        // A store emptied under an open editor still shows that editor's row.
        const vanished = open?.store === store && !selected && Boolean(list.data)
        if (!inStore.length && !vanished) return null
        return (
          <div key={store} className={styles.memoryStore}>
            <h3 className={styles.memoryStoreTitle}>{title}</h3>
            <p className={styles.note}>{hint}</p>
            <ul className={styles.rows}>
              {/* One array, so the vanished entry's row keeps its key's state. */}
              {[
                ...inStore.map((entry, index) => {
                  const isOpen = selected?.id === entry.id
                  return (
                    // Keyed by place, not id: a saved entry gets a new id, and a
                    // remount would drop the editor's "Restore previous version".
                    <li key={`${store}:${index}`} className={styles.memoryItem}>
                      <div className={styles.row}>
                        {/* Open, the editor shows the text; the row names the entry instead. */}
                        {isOpen ? (
                          <p className={styles.memoryPlace}>
                            {store === 'memory' ? 'Agent note' : 'Note about you'}{' '}
                            {index + 1}
                          </p>
                        ) : (
                          <p className={styles.memoryText}>
                            {entry.preview}
                            {entry.truncated ? '…' : ''}
                          </p>
                        )}
                        <Button
                          variant="quiet"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Close' : 'Open'} memory entry: ${entry.title}`}
                          onClick={() =>
                            setOpen(isOpen ? undefined : positionOf(entries, entry.id))
                          }
                        >
                          {isOpen ? 'Close' : 'Open'}
                        </Button>
                      </div>
                      {isOpen ? editor(entry, index + 1) : null}
                    </li>
                  )
                }),
                ...(vanished && open
                  ? [
                      // The open entry vanished with nothing after it: keep its row,
                      // and the draft in it, until the owner closes it.
                      <li key={`${store}:${open.index}`} className={styles.memoryItem}>
                        <div className={styles.row}>
                          <p className={styles.memoryPlace}>Removed in Hermes</p>
                          <Button
                            variant="quiet"
                            aria-expanded={true}
                            aria-label="Close the removed memory entry"
                            onClick={() => setOpen(undefined)}
                          >
                            Close
                          </Button>
                        </div>
                        {editor(undefined, open.index + 1)}
                      </li>,
                    ]
                  : []),
              ]}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function MemoryEntryEditor({
  summary,
  place,
  onChanged,
  onDeleted,
}: {
  /** The entry the list shows at this place; missing once it vanished. */
  summary: MemoryEntrySummary | undefined
  /** 1-based position in its store, as the row shows it. */
  place: number
  onChanged: () => void
  onDeleted: () => void
}) {
  const api = useCindlApi()
  const canWrite = useCan('memory.text')
  // Keyed by place: a save gives the entry a new id, and a new key would drop
  // the editor (and its "Restore previous version") until the read finished.
  const entry = useResource(
    () =>
      summary
        ? api.call('memory.read', { id: summary.id })
        : Promise.reject(
            new CindlError('not-found', 'This entry was removed in Hermes.'),
          ),
    `memory:${place}`,
    'This entry could not be loaded. It may have changed; reload the list.',
  )
  // The editor stays bound to the entry it read. When the list shows another
  // id at this place, only the same text under a new number (an earlier entry
  // was removed) is the same entry for certain, and is followed. Other text
  // may be this entry changed elsewhere, or another entry removed, merged or
  // added in its place; Hermes's list cannot tell them apart, so the editor
  // locks: its draft is kept, read-only, and nothing is saved or deleted until
  // the owner explicitly uses the draft for the entry now here. After a save
  // here the list catches up to the saved id: no re-read.
  const [binding, setBinding] = useState<'following' | 'locked' | { adopting: string }>(
    'following',
  )
  const adopting = typeof binding === 'object' ? binding.adopting : undefined
  const locked =
    binding === 'locked' || (adopting !== undefined && entry.data?.id !== adopting)
  const followList = useEffectEvent((listed: string | undefined) => {
    if (locked) return
    const shown = entry.data?.id
    if (listed === undefined) setBinding('locked')
    else if (shown === undefined || shown === listed) {
      if (entry.error) entry.reload()
    } else if (fingerprintOf(shown) === fingerprintOf(listed)) entry.reload()
    else setBinding('locked')
  })
  // Locking happens at most once per change under an open editor, and only
  // when the list changes; deriving it at render time would let a later
  // reload unlock it onto a different entry.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- set once per list change, cannot cascade
  useEffect(() => followList(summary?.id), [summary?.id])
  // The label names the place ("agent note 2"); a kept draft is filed under the
  // text it was written for, so it only ever returns to that entry. Writes and
  // deletes name the id of the entry that was read and reviewed, never the
  // list's, so Hermes refuses them if it changed since.
  const toDocument = (data: MemoryEntry): VersionedDocument => ({
    key: `${data.store === 'memory' ? 'agent note' : 'note about you'} ${place}`,
    content: data.content,
    version: sha256Hex(data.content.trim()),
    readAt: data.readAt,
    source: data.source,
  })
  const data = entry.data
  const draftKey = data ? `${MEMORY_DRAFT_PREFIX}${fingerprintOf(data.id)}` : undefined
  return (
    <div className={styles.memoryEditor}>
      {entry.error && !locked ? (
        <div className={styles.actions}>
          <p className={styles.error}>{entry.error}</p>
          <Button
            variant="quiet"
            onClick={() => {
              entry.reload()
              onChanged()
            }}
          >
            Reload
          </Button>
        </div>
      ) : null}
      {data && draftKey ? (
        <>
          <DocumentEditor
            document={toDocument(data)}
            draftKey={draftKey}
            canWrite={canWrite}
            locked={
              locked
                ? 'The entry this editor showed was changed, removed or moved in Hermes, and Cindl cannot tell which, so nothing here can be saved or deleted. Your text is kept below to copy.'
                : undefined
            }
            onAdopt={
              summary && !adopting
                ? () => {
                    // The owner chose the entry now here: the draft moves to it,
                    // and the editor stays locked until that entry is read.
                    forgetDocumentDraft(draftKey)
                    setBinding({ adopting: summary.id })
                    entry.reload()
                  }
                : undefined
            }
            // The list names the entry's current id; the read follows it.
            onReload={onChanged}
            onSave={async (content, reviewed) => {
              if (locked || toDocument(data).version !== reviewed)
                throw new CindlError(
                  'conflict',
                  'This entry changed since you reviewed it. Review it again.',
                )
              const saved = await api.call('memory.write', {
                id: data.id,
                content,
                confirm: true,
              })
              entry.replace(saved)
              onChanged()
              return toDocument(saved)
            }}
          />
          {canWrite && !locked ? (
            // Keyed by id: if the entry here changes, an open confirmation
            // closes instead of deleting another entry.
            <DeleteEntry
              key={data.id}
              id={data.id}
              title={summary?.title ?? data.content.split('\n')[0] ?? ''}
              onDeleted={onDeleted}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function DeleteEntry({
  id,
  title,
  onDeleted,
}: {
  id: string
  title: string
  onDeleted: () => void
}) {
  const api = useCindlApi()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!confirming)
    return (
      <div className={styles.actions}>
        <Button variant="quiet" onClick={() => setConfirming(true)}>
          Delete entry…
        </Button>
      </div>
    )
  return (
    <div className={styles.confirm} role="group" aria-label="Delete this memory entry">
      <p>
        Delete “{title}” from Hermes's memory? Hermes keeps no backup, so this cannot be
        undone.
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button disabled={busy} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(undefined)
            void api
              .call('memory.delete', { id, confirm: true })
              .then(onDeleted, (err: unknown) => {
                setBusy(false)
                setError(
                  isCindlError(err)
                    ? err.message
                    : 'Cindl could not confirm the delete. Reload the list to see whether it happened.',
                )
              })
          }}
        >
          Delete permanently
        </Button>
      </div>
    </div>
  )
}
