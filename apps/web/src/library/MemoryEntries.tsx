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
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
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
 * which only changes with the text. Entries with identical text in one store
 * share one identity (Hermes resolves either to the first), a known limit.
 */
const fingerprintOf = (id: string) => {
  const [, store, , fingerprint] = id.split(':')
  return `${store}:${fingerprint}`
}

/** Kept memory drafts are filed under the entry they were written for. */
const MEMORY_DRAFT_PREFIX = 'memory-draft:'

/**
 * How a confirmation names an entry: the first line of the text Cindl read,
 * cut as Hermes cuts its card titles (`agent/learning_graph.py`).
 */
const firstWords = (content: string) =>
  content
    .split('\n')
    .map((line) => line.replace(/^[#\s]+/, '').trim())
    .find((line) => line.length > 0)
const cut = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text)
const titleOf = (content: string) => cut(firstWords(content) ?? 'this entry')

/**
 * An entry's name in labels: Hermes's title; when that is empty (a first line
 * of only heading marks), its first line with words; when it has none, its
 * place, so no two entries share a name.
 */
const nameOf = (entry: MemoryEntrySummary, place: string) =>
  entry.title.trim() || cut(firstWords(entry.preview) ?? place)

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
  const heading = useRef<HTMLHeadingElement>(null)
  const headingNext = useRef(false)
  useLayoutEffect(() => {
    if (!headingNext.current) return
    headingNext.current = false
    heading.current?.focus()
  })
  const entries = list.data ?? []
  const selected = open ? atPosition(entries, open) : undefined
  // Drafts kept for entries Hermes no longer lists (removed, or rewritten
  // elsewhere), and drafts kept beside an entry's own draft. They attach to no
  // other entry (except one with identical text, which shares the identity);
  // the owner copies or discards them. Shown while no entry is open, which also
  // keeps a locked editor's draft from appearing twice.
  const listed = new Set(entries.map((entry) => fingerprintOf(entry.id)))
  const orphans =
    open || !list.data
      ? []
      : // A draft filed beside another (`…#2`) never matches a listed entry, so it
        // is always listed here.
        keptDocumentDrafts(MEMORY_DRAFT_PREFIX).filter(
          ({ key }) => !listed.has(key.slice(MEMORY_DRAFT_PREFIX.length)),
        )
  // Each discard button names its draft; drafts sharing a first line are
  // numbered, so no two buttons have the same name.
  const discardName = (key: string, draft: string) => {
    const title = titleOf(draft)
    const same = orphans.filter((orphan) => titleOf(orphan.draft) === title)
    return same.length === 1
      ? `Discard draft: ${title}`
      : `Discard draft ${same.findIndex((orphan) => orphan.key === key) + 1} of ${same.length}: ${title}`
  }
  // Where the entry with this identity is listed now (1-based in its store),
  // when exactly one entry has that text.
  const placeNow = (identity: string) => {
    const [store] = identity.split(':')
    const places = entries
      .filter((entry) => entry.store === store)
      .flatMap((entry, index) =>
        fingerprintOf(entry.id) === identity ? [index + 1] : [],
      )
    return places.length === 1 ? places[0] : undefined
  }
  // A draft kept beside a listed entry's own draft says which entry it is for.
  const writtenFor = (key: string) => {
    const identity = key.slice(MEMORY_DRAFT_PREFIX.length).split('#')[0] ?? ''
    const at = key.includes('#') ? placeNow(identity) : undefined
    return at === undefined ? null : (
      <p className={styles.note}>
        Written for {identity.startsWith('profile:') ? 'note about you' : 'agent note'}{' '}
        {at}.
      </p>
    )
  }
  const editor = (summary: MemoryEntrySummary | undefined, place: number) => (
    <MemoryEntryEditor
      summary={summary}
      place={place}
      placeNow={placeNow}
      onChanged={list.reload}
      onDeleted={() => {
        // The entry and its editor are gone: focus goes to the list's heading.
        headingNext.current = true
        setOpen(undefined)
        list.reload()
      }}
    />
  )
  return (
    <section className={styles.section} aria-labelledby="memory-entries-title">
      <SectionTitle id="memory-entries-title" ref={heading} tabIndex={-1}>
        Entries
      </SectionTitle>
      {list.error ? <p className={styles.error}>{list.error}</p> : null}
      {list.data && !entries.length ? (
        <p className={styles.note}>Hermes has no memory entries yet.</p>
      ) : null}
      {orphans.length ? (
        <div className={styles.memoryStore}>
          <h3 className={styles.memoryStoreTitle}>Unsaved drafts</h3>
          <p className={styles.note}>
            Text you wrote for entries Hermes no longer lists (removed, or changed
            elsewhere), and drafts kept beside an entry's own draft. Copy what you need;
            nothing here is saved.
          </p>
          <ul className={styles.rows}>
            {orphans.map(({ key, draft }) => (
              <li key={key} className={styles.memoryItem}>
                {writtenFor(key)}
                <pre className={styles.doc}>{draft}</pre>
                <div className={styles.actions}>
                  <Button
                    variant="quiet"
                    aria-label={discardName(key, draft)}
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
                          aria-label={`${isOpen ? 'Close' : 'Open'} memory entry: ${nameOf(entry, `${store === 'memory' ? 'agent note' : 'note about you'} ${index + 1}`)}`}
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
                          <p className={styles.memoryPlace}>No longer at this place</p>
                          <Button
                            variant="quiet"
                            aria-expanded={true}
                            aria-label="Close the entry no longer at this place"
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
  placeNow,
  onChanged,
  onDeleted,
}: {
  /** The entry the list shows at this place; missing once it vanished. */
  summary: MemoryEntrySummary | undefined
  /** 1-based position in its store, as the row shows it. */
  place: number
  /** Where an identity is listed now, if exactly one entry has that text. */
  placeNow: (identity: string) => number | undefined
  onChanged: () => void
  onDeleted: () => void
}) {
  const api = useCindlApi()
  const canWrite = useCan('memory.text')
  // The entry this editor is for, by store and text fingerprint: the one the
  // owner opened, then the text a save here gave it, or the entry the owner
  // explicitly chose to use a draft for. It never changes otherwise.
  const [identity, setIdentity] = useState(() => summary && fingerprintOf(summary.id))
  // The row's id when a save here landed: until the list catches up, the row
  // still shows the text that save replaced, and it is still this entry.
  const [savedFrom, setSavedFrom] = useState<string>()
  const rowIsIt =
    summary !== undefined &&
    (fingerprintOf(summary.id) === identity || summary.id === savedFrom)
  // Keyed by place: a save gives the entry a new id, and a new key would drop
  // the editor (and its "Restore previous version") until the read finished.
  // Only this entry is ever read here; another entry at the place is not.
  const entry = useResource(
    () =>
      summary && rowIsIt
        ? api.call('memory.read', { id: summary.id })
        : Promise.reject(
            summary
              ? new CindlError('conflict', 'Another entry is at this place now.')
              : new CindlError('not-found', 'This entry was removed in Hermes.'),
          ),
    `memory:${place}`,
    'This entry could not be loaded. It may have changed; reload the list.',
  )
  const data = entry.data
  const readIsIt = data !== undefined && fingerprintOf(data.id) === identity
  // Locked while the list shows another entry (or none) at this place, or the
  // text read is not this entry's. Other text at the place may be this entry
  // changed elsewhere, or another entry removed, merged or added in its place;
  // Hermes's list cannot tell them apart. A locked editor keeps its draft,
  // read-only, and saves or deletes nothing.
  const locked = !rowIsIt || !readIsIt
  // The same entry under a new number (an entry was removed from the other
  // store) is read again for its current id; a failed read is retried.
  const followList = useEffectEvent(() => {
    if (savedFrom !== undefined && summary?.id !== savedFrom) setSavedFrom(undefined)
    if (!summary || !rowIsIt || summary.id === savedFrom) return
    if (entry.error || (data !== undefined && data.id !== summary.id)) entry.reload()
  })
  // eslint-disable-next-line react-hooks/set-state-in-effect -- clears a one-shot marker when the list moves on
  useEffect(() => followList(), [summary?.id, data?.id])

  // "Use this draft for the entry now here" reads that entry first. Nothing
  // changes unless the read succeeds and the entry is still at this place;
  // until then (or on failure, or if the editor closes) the draft stays kept
  // under the entry it was written for.
  const [adoption, setAdoption] = useState<{ busy: boolean; error?: string }>()
  const [adoptedFrom, setAdoptedFrom] = useState<string>()
  const row = useRef(summary)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    row.current = summary
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The label names the place ("agent note 2"); a kept draft is filed under the
  // text it was written for, so it only ever returns to that entry. Writes and
  // deletes name the id of the entry that was read and reviewed, never the
  // list's, so Hermes refuses them if it changed since.
  const label =
    (data?.store ?? summary?.store) === 'profile' ? 'note about you' : 'agent note'
  const toDocument = (read: MemoryEntry): VersionedDocument => ({
    key: `${label} ${place}`,
    content: read.content,
    version: sha256Hex(read.content.trim()),
    readAt: read.readAt,
    source: read.source,
  })
  const ownKey = identity === undefined ? undefined : `${MEMORY_DRAFT_PREFIX}${identity}`
  // A draft used for this entry stays filed under the entry it was written
  // for until it is saved here or discarded, so this entry's own kept draft
  // (if any) is never replaced.
  const draftKey = adoptedFrom ?? ownKey
  const movedTo = identity === undefined ? undefined : placeNow(identity)
  // Each adoption has a number; a discard (or a newer adoption) retires it.
  const adoptions = useRef(0)
  const adopt = (target: MemoryEntrySummary, from: string) => {
    const run = (adoptions.current += 1)
    setAdoption({ busy: true })
    api.call('memory.read', { id: target.id }).then(
      (read) => {
        if (!mounted.current || run !== adoptions.current) return
        const wanted = fingerprintOf(target.id)
        const here = row.current
        if (
          fingerprintOf(read.id) !== wanted ||
          !here ||
          fingerprintOf(here.id) !== wanted
        ) {
          setAdoption({
            busy: false,
            error: 'The entry at this place changed again while Cindl read it.',
          })
          return
        }
        entry.replace(read)
        // A draft used for the entry it was written for is that entry's own again.
        setAdoptedFrom(from === `${MEMORY_DRAFT_PREFIX}${wanted}` ? undefined : from)
        setIdentity(wanted)
        setSavedFrom(undefined)
        setAdoption(undefined)
      },
      (err: unknown) => {
        if (!mounted.current || run !== adoptions.current) return
        setAdoption({
          busy: false,
          error: isCindlError(err)
            ? err.message
            : 'Cindl could not read the entry now here.',
        })
        // Changed or gone since the list was read: fetch the list, so the next
        // try names the entry that is here now.
        if (isCindlError(err) && (err.code === 'conflict' || err.code === 'not-found'))
          onChanged()
      },
    )
  }
  // What the lock says, and where the draft in the box goes when this closes:
  // an entry's own kept draft returns when that entry is opened; a draft kept
  // beside another (`#n`) waits under Unsaved drafts; a draft written for
  // another entry returns to that entry while it is listed, and otherwise
  // waits under Unsaved drafts.
  const lockMessage = (keptAs: string | undefined) => {
    const base =
      'The entry this editor showed was changed, removed or moved in Hermes, and Cindl cannot tell which, so nothing here can be saved or deleted. Your text is kept below to copy.'
    if (movedTo === undefined || movedTo === place) return base
    const here = `${base} The same text is now ${label} ${movedTo}`
    if (keptAs === undefined || keptAs === ownKey)
      return `${here}; close this and open it there to keep editing it.`
    if (keptAs.includes('#'))
      return `${here}. The text you were editing is kept apart from that entry's own draft, so when you close this it stays under Unsaved drafts.`
    const source = keptAs.slice(MEMORY_DRAFT_PREFIX.length)
    const sourcePlace = placeNow(source)
    return sourcePlace === undefined
      ? `${here}. This draft was written for another entry, so when you close this it stays under Unsaved drafts.`
      : `${here}. This draft was written for ${source.startsWith('profile:') ? 'note about you' : 'agent note'} ${sourcePlace}, so when you close this it goes back to that entry.`
  }
  // A control here outside the document editor (the error row's Reload) that
  // goes takes focus with it; focus moves to the editor's first control. The
  // document editor moves focus itself first for its own controls.
  const editorRoot = useRef<HTMLDivElement>(null)
  const lastFocused = useRef<Element | null>(null)
  useLayoutEffect(() => {
    const page = editorRoot.current?.ownerDocument
    if (!page) return
    const active = page.activeElement
    if (active && active !== page.body) {
      lastFocused.current = editorRoot.current?.contains(active) ? active : null
      return
    }
    const was = lastFocused.current
    lastFocused.current = null
    if (was === null || was.isConnected) return
    editorRoot.current
      ?.querySelector<HTMLElement>('textarea, button:not(:disabled), [tabindex="-1"]')
      ?.focus()
  })
  const otherDraft =
    adoptedFrom !== undefined &&
    ownKey !== undefined &&
    keptDocumentDrafts(ownKey).some(({ key }) => key === ownKey)
  return (
    <div
      className={styles.memoryEditor}
      ref={editorRoot}
      onFocus={(event) => {
        lastFocused.current = event.target
      }}
      onBlur={(event) => {
        if (event.target.isConnected && !event.target.matches(':disabled'))
          lastFocused.current = null
      }}
    >
      {entry.error && (!data || !locked) ? (
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
            locked={locked ? lockMessage : undefined}
            nowHere={locked && summary ? nameOf(summary, `${label} ${place}`) : undefined}
            onAdopt={
              summary && locked
                ? (keptAs) => adopt(summary, keptAs ?? draftKey)
                : undefined
            }
            adoption={adoption}
            draftNote={
              adoptedFrom
                ? `This draft was written for the entry that was here before. Review it against this entry's text before saving; until you save or discard it, it stays kept for that entry.${
                    otherDraft
                      ? ' This entry also has an unsaved draft of its own, which stays kept.'
                      : ''
                  }`
                : undefined
            }
            keepDraft={adoptedFrom !== undefined}
            onDiscard={() => {
              adoptions.current += 1
              setAdoption(undefined)
              setAdoptedFrom(undefined)
            }}
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
              setSavedFrom(summary?.id)
              setIdentity(fingerprintOf(saved.id))
              setAdoptedFrom(undefined)
              onChanged()
              return toDocument(saved)
            }}
          />
          {canWrite && !locked ? (
            // Keyed by id: if the entry here changes, an open confirmation
            // closes instead of deleting another entry. It names the text
            // read under that id, the entry the delete names.
            <DeleteEntry
              key={data.id}
              id={data.id}
              title={titleOf(data.content)}
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
  // The owner's choice moves focus: opening the confirmation to "Keep it",
  // keeping the entry back to "Delete entry…", and deleting (both buttons
  // disabled) to the confirmation itself.
  const opener = useRef<HTMLButtonElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const group = useRef<HTMLDivElement>(null)
  const focusNext = useRef<'opener' | 'keep' | 'group'>(undefined)
  useLayoutEffect(() => {
    const next = focusNext.current
    focusNext.current = undefined
    if (next) ({ opener, keep, group })[next].current?.focus()
  })
  if (!confirming)
    return (
      <div className={styles.actions}>
        <Button
          variant="quiet"
          ref={opener}
          onClick={() => {
            focusNext.current = 'keep'
            setConfirming(true)
          }}
        >
          Delete entry…
        </Button>
      </div>
    )
  return (
    <div
      className={styles.confirm}
      role="group"
      aria-label="Delete this memory entry"
      ref={group}
      tabIndex={-1}
    >
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
        <Button
          disabled={busy}
          ref={keep}
          onClick={() => {
            focusNext.current = 'opener'
            setConfirming(false)
          }}
        >
          Keep it
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            focusNext.current = 'group'
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
