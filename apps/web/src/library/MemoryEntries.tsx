import { sha256Hex } from '@cindl/client-core'
import { useCan, useCindlApi } from '@cindl/client-react'
import {
  isCindlError,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryStore,
  type VersionedDocument,
} from '@cindl/contracts'
import { useState } from 'react'
import { Button, SectionTitle } from '../ui/primitives.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { useResource } from '../views/useResource.ts'
import styles from '../views/views.module.css'

const stores: Array<{ store: MemoryStore; title: string; hint: string }> = [
  { store: 'memory', title: 'Agent notes', hint: 'What Hermes noted for itself.' },
  { store: 'profile', title: 'About you', hint: 'What Hermes keeps about you.' },
]

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
              {inStore.map((entry, index) => {
                const isOpen = selected?.id === entry.id
                return (
                  <li key={entry.id} className={styles.memoryItem}>
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
                    {isOpen ? (
                      <MemoryEntryEditor
                        summary={entry}
                        onChanged={list.reload}
                        onDeleted={() => {
                          setOpen(undefined)
                          list.reload()
                        }}
                      />
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function MemoryEntryEditor({
  summary,
  onChanged,
  onDeleted,
}: {
  summary: MemoryEntrySummary
  onChanged: () => void
  onDeleted: () => void
}) {
  const api = useCindlApi()
  const canWrite = useCan('memory.text')
  const entry = useResource(
    () => api.call('memory.read', { id: summary.id }),
    `memory:${summary.id}`,
    'This entry could not be loaded. It may have changed; reload the list.',
  )
  // The editor's draft key names the entry's place in its store ("agent note 2"),
  // so a draft kept after a conflict comes back once the entry is reloaded under
  // its new id. Writes still name the exact version that was reviewed.
  const place = Number(summary.id.split(':')[2] ?? 0) + 1
  const toDocument = (data: MemoryEntry): VersionedDocument => ({
    key: `${data.store === 'memory' ? 'agent note' : 'note about you'} ${place}`,
    content: data.content,
    version: sha256Hex(data.content.trim()),
    readAt: data.readAt,
    source: data.source,
  })
  return (
    <div className={styles.memoryEditor}>
      {entry.error ? <p className={styles.error}>{entry.error}</p> : null}
      {entry.data ? (
        <>
          <DocumentEditor
            document={toDocument(entry.data)}
            canWrite={canWrite}
            onReload={onChanged}
            onSave={async (content) => {
              const saved = await api.call('memory.write', {
                id: summary.id,
                content,
                confirm: true,
              })
              onChanged()
              return toDocument(saved)
            }}
          />
          {canWrite ? <DeleteEntry id={summary.id} onDeleted={onDeleted} /> : null}
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
