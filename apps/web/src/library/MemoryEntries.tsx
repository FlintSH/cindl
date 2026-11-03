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
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Button, SectionTitle } from '../ui/primitives.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
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
  const entries = list.data ?? []
  const selected = open ? atPosition(entries, open) : undefined
  // Ids of the list before the current one. An open editor reads it (in its
  // effects, which run before this one) to tell an entry changed in place from
  // another entry that moved into the place.
  const listedBefore = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    listedBefore.current = new Set(
      (list.data ?? []).map((entry) => fingerprintOf(entry.id)),
    )
  }, [list.data])
  const editor = (summary: MemoryEntrySummary | undefined, place: number) => (
    <MemoryEntryEditor
      summary={summary}
      place={place}
      wasListed={(id) => listedBefore.current.has(fingerprintOf(id))}
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
      {stores.map(({ store, title, hint }) => {
        const inStore = entries.filter((entry) => entry.store === store)
        if (!inStore.length) return null
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
                ...(open?.store === store && !selected && list.data
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
  wasListed,
  onChanged,
  onDeleted,
}: {
  /** The entry the list shows at this place; missing once it vanished. */
  summary: MemoryEntrySummary | undefined
  /** 1-based position in its store, as the row shows it. */
  place: number
  /** Whether the list before the current one held this entry (by fingerprint). */
  wasListed: (id: string) => boolean
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
  // When the list shows another id at this place: the same text renumbered
  // (an earlier entry was removed) or text Hermes never listed before (the
  // entry was changed elsewhere) is followed, keeping the editor and any draft
  // while it loads; text that was already listed (another entry moved into
  // the place, so the one this editor shows was removed or moved) locks the
  // editor rather than follow a different entry. A failed read is retried the
  // same way. After a save here the list catches up to the saved id: no
  // re-read.
  const [replaced, setReplaced] = useState(false)
  const followList = useEffectEvent((listed: string | undefined) => {
    if (replaced) return
    const shown = entry.data?.id
    // Same text under a new number: an earlier entry was removed. Follow it.
    const renumbered =
      shown !== undefined &&
      listed !== undefined &&
      fingerprintOf(shown) === fingerprintOf(listed)
    if (
      listed === undefined ||
      (shown !== undefined && shown !== listed && !renumbered && wasListed(listed))
    )
      setReplaced(true)
    else if (entry.error || (shown !== undefined && shown !== listed)) entry.reload()
  })
  // The latch is set at most once, only when the list changes under an open
  // editor; deriving it at render time would let a later reload unlock it onto
  // a different entry.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time latch, cannot cascade
  useEffect(() => followList(summary?.id), [summary?.id])
  // The editor's draft key names the entry's place in its store ("agent note 2"),
  // so a draft kept after a conflict comes back once the entry is reloaded under
  // its new id. Not the id's index: Hermes numbers entries across both stores.
  // Writes and deletes name the id of the entry that was read and reviewed,
  // never the list's, so Hermes refuses them if it changed since.
  const toDocument = (data: MemoryEntry): VersionedDocument => ({
    key: `${data.store === 'memory' ? 'agent note' : 'note about you'} ${place}`,
    content: data.content,
    version: sha256Hex(data.content.trim()),
    readAt: data.readAt,
    source: data.source,
  })
  const data = entry.data
  return (
    <div className={styles.memoryEditor}>
      {entry.error && !replaced ? (
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
      {data ? (
        <>
          <DocumentEditor
            document={toDocument(data)}
            canWrite={canWrite}
            locked={
              replaced
                ? 'The entry this editor showed was removed or moved in Hermes, so nothing here can be saved. Any text you wrote is kept below to copy; close this and open the entry again.'
                : undefined
            }
            // The list names the entry's current id; the read follows it.
            onReload={onChanged}
            onSave={async (content, reviewed) => {
              if (toDocument(data).version !== reviewed)
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
          {canWrite && !replaced ? (
            // Keyed by id: if another entry takes this place, an open
            // confirmation closes instead of deleting the newcomer.
            <DeleteEntry key={data.id} id={data.id} onDeleted={onDeleted} />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function DeleteEntry({ id, onDeleted }: { id: string; onDeleted: () => void }) {
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
        Delete this entry from Hermes's memory? Hermes keeps no backup, so this cannot be
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
