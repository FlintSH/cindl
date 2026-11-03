import { useCan, useCapability, useCindlApi } from '@cindl/client-react'
import {
  CindlError,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryStore,
} from '@cindl/contracts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { Dialog } from '../overlay/Sheet.tsx'
import { describeFailure } from '../talk/failures.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, Empty, ErrorText, Note, Txt } from '../ui/primitives.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { forgetDocumentDraft, keptDocumentDrafts, keptDrafts } from '../views/drafts.ts'
import { useResource } from '../views/useResource.ts'
import {
  adoptionRuns,
  bindingAfterSave,
  CLOSE_NO_LONGER_HERE,
  DELETE_REFUSED,
  DELETE_UNCERTAIN,
  deleteWarning,
  discardDraftLabel,
  entryAt,
  entryEditorView,
  followList,
  guardMemorySave,
  identityOf,
  keepsVanishedRow,
  MEMORY_DRAFT_PREFIX,
  memoryDelete,
  memoryDocument,
  memoryEntryName,
  memoryStores,
  memoryWrite,
  NO_LONGER_HERE,
  orphanDrafts,
  placeNow,
  placeOf,
  readForAdoption,
  readRequest,
  rowIsEntry,
  type EditorBinding,
  type MemoryPlace,
} from './memory.ts'

/**
 * Hermes's memory entries, opened one at a time (web parity:
 * apps/web/src/library/MemoryEntries.tsx). An open editor stays bound to the
 * entry it read: edits go through the reviewed diff and the write names that
 * entry's id; a delete asks first, names the entry and is permanent. Drafts
 * are kept under the entry they were written for, never its place (entries
 * with identical text in one store share one identity, a known limit).
 */
export function MemoryEntries() {
  const api = useCindlApi()
  const theme = useTheme()
  const list = useResource(
    () => api.call('memory.entries', {}),
    'memory-entries',
    'Memory entries could not be loaded.',
  )
  const [open, setOpen] = useState<MemoryPlace>()
  const [, setDraftsSeen] = useState(0)
  const entries = list.data ?? []
  const selected = open ? entryAt(entries, open) : undefined
  // Drafts whose entry Hermes no longer lists, shown while no entry is open (an
  // open locked editor shows its own).
  const orphans =
    open || !list.data
      ? []
      : orphanDrafts(entries, keptDocumentDrafts(MEMORY_DRAFT_PREFIX))
  const editor = (
    store: MemoryStore,
    summary: MemoryEntrySummary | undefined,
    place: number,
  ) => (
    <EntryEditor
      store={store}
      summary={summary}
      place={place}
      placeNow={(identity) => placeNow(entries, identity)}
      onChanged={list.reload}
      onDeleted={() => {
        setOpen(undefined)
        list.reload()
      }}
    />
  )
  return (
    <View style={{ gap: theme.space[4] }}>
      {list.error ? <ErrorText>{list.error}</ErrorText> : null}
      {!list.data && !list.error ? <Note>Loading memory entries…</Note> : null}
      {list.data && !entries.length && !open ? (
        <Empty>Hermes has no memory entries yet.</Empty>
      ) : null}
      {orphans.length ? (
        <View style={{ gap: theme.space[2] }}>
          <StoreTitle>Unsaved drafts</StoreTitle>
          <Note>
            Text you wrote for entries Hermes no longer lists (removed, or changed
            elsewhere). Copy what you need; nothing here is saved.
          </Note>
          {orphans.map(({ key, draft }) => (
            <View key={key} style={rowStyle(theme)}>
              <Text selectable style={[theme.text.code, { color: theme.colors.text }]}>
                {draft}
              </Text>
              <Button
                label="Discard draft"
                accessibilityLabel={discardDraftLabel(draft)}
                variant="quiet"
                style={{ alignSelf: 'flex-end' }}
                onPress={() => {
                  forgetDocumentDraft(key)
                  setDraftsSeen((value) => value + 1)
                }}
              />
            </View>
          ))}
        </View>
      ) : null}
      {memoryStores.map(({ store, title, hint }) => {
        const inStore = entries.filter((entry) => entry.store === store)
        // A store emptied under an open editor still shows that editor's row.
        const vanished =
          open?.store === store && keepsVanishedRow(open, selected, Boolean(list.data))
        if (!inStore.length && !vanished) return null
        return (
          <View key={store} style={{ gap: theme.space[2] }}>
            <StoreTitle>{title}</StoreTitle>
            <Note>{hint}</Note>
            {/* One array, so the vanished entry's row keeps its key's state. */}
            {[
              ...inStore.map((entry, index) => {
                const isOpen = selected?.id === entry.id
                return (
                  // Keyed by place, not id: a saved entry gets a new id, and a
                  // remount would drop the editor's "Restore previous version".
                  <View key={`${store}:${index}`} style={rowStyle(theme)}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.space[2],
                      }}
                    >
                      {/* Open, the editor shows the text; the row names the entry instead. */}
                      <Txt style={{ flex: 1 }}>
                        {isOpen
                          ? capitalized(memoryEntryName(store, index + 1))
                          : `${entry.preview}${entry.truncated ? '…' : ''}`}
                      </Txt>
                      <Button
                        label={isOpen ? 'Close' : 'Open'}
                        accessibilityLabel={`${isOpen ? 'Close' : 'Open'} memory entry: ${entry.title}`}
                        variant="quiet"
                        onPress={() =>
                          setOpen(isOpen ? undefined : placeOf(entries, entry.id))
                        }
                      />
                    </View>
                    {isOpen ? editor(store, entry, index + 1) : null}
                  </View>
                )
              }),
              ...(vanished && open
                ? [
                    // The open entry vanished with nothing after it: keep its row,
                    // and the draft in it, until the owner closes it.
                    <View key={`${store}:${open.index}`} style={rowStyle(theme)}>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: theme.space[2],
                        }}
                      >
                        <Txt style={{ flex: 1 }}>{NO_LONGER_HERE}</Txt>
                        <Button
                          label="Close"
                          accessibilityLabel={CLOSE_NO_LONGER_HERE}
                          variant="quiet"
                          onPress={() => setOpen(undefined)}
                        />
                      </View>
                      {editor(store, undefined, open.index + 1)}
                    </View>,
                  ]
                : []),
            ]}
          </View>
        )
      })}
    </View>
  )
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

function rowStyle(theme: ReturnType<typeof useTheme>) {
  return {
    gap: theme.space[3],
    padding: theme.space[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
  }
}

function StoreTitle({ children }: { children: string }) {
  const theme = useTheme()
  return (
    <Text
      accessibilityRole="header"
      style={[
        theme.text.ui,
        { fontFamily: theme.fonts.semibold, color: theme.colors.text },
      ]}
    >
      {children}
    </Text>
  )
}

function EntryEditor({
  store,
  summary,
  place,
  placeNow: whereNow,
  onChanged,
  onDeleted,
}: {
  store: MemoryStore
  /** The entry the list shows at this place; missing once it vanished. */
  summary: MemoryEntrySummary | undefined
  /** 1-based position in its store, as the row shows it. */
  place: number
  /** Where an identity is listed now, if exactly one entry has that text. */
  placeNow: (identity: string | undefined) => number | undefined
  onChanged: () => void
  onDeleted: () => void
}) {
  const api = useCindlApi()
  const theme = useTheme()
  const canWrite = useCan('memory.text')
  const write = useCapability('memory.text')
  // The entry this editor is for (memory.ts EditorBinding): the one the owner
  // opened, then the text a save here gave it, or the entry the owner chose to
  // use a draft for. It never changes otherwise.
  const [binding, setBinding] = useState<EditorBinding>(() => ({
    identity: summary && identityOf(summary.id),
    savedFrom: undefined,
  }))
  // A draft used for this entry ("Use this draft for the entry now here") stays
  // filed under the entry it was written for until it is saved here or
  // discarded, so this entry's own kept draft (if any) is never replaced.
  const [adoptedFrom, setAdoptedFrom] = useState<string>()
  // Keyed by place: a save gives the entry a new id, and a new key would drop the
  // editor (and its "Restore previous version") until the read finished. Only this
  // entry is ever read here; another entry at the place is not.
  const entry = useResource(
    () => {
      const request = readRequest(summary?.id, rowIsEntry(summary?.id, binding))
      return request instanceof CindlError
        ? Promise.reject(request)
        : api.call('memory.read', request)
    },
    `memory:${store}:${place}`,
    'This entry could not be loaded. It may have changed; reload the list.',
  )
  const data = entry.data
  const view = entryEditorView({
    binding,
    adoptedFrom,
    row: summary,
    read: data,
    store,
    place,
    placeNow: whereNow,
    kept: (key) => keptDrafts.has(key),
  })
  const { locked, draftKey } = view
  // Once per change of the row or the read (adjusted while rendering, as React
  // advises for state that follows a prop): clear the save marker once the list
  // moved on, and read the same entry again under a new number.
  const [followed, setFollowed] = useState<[string | undefined, string | undefined]>([
    summary?.id,
    data?.id,
  ])
  if (followed[0] !== summary?.id || followed[1] !== data?.id) {
    setFollowed([summary?.id, data?.id])
    const next = followList({
      rowId: summary?.id,
      savedFrom: binding.savedFrom,
      rowIsIt: view.rowIsIt,
      readId: data?.id,
      readFailed: entry.error !== undefined,
    })
    if (next.clearSavedFrom) setBinding({ ...binding, savedFrom: undefined })
    if (next.reread) entry.reload()
  }

  // "Use this draft for the entry now here" reads that entry first (memory.ts
  // readForAdoption). Until it succeeds, and if it fails or the editor closes,
  // the draft stays kept under the entry it was written for. A discard (or a
  // newer adoption) retires the one that is out (memory.ts adoptionRuns).
  const [adoption, setAdoption] = useState<{ busy: boolean; error?: string }>()
  const [runs] = useState(adoptionRuns)
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
  const adopt = (target: MemoryEntrySummary, from: string) => {
    const run = runs.start()
    setAdoption({ busy: true })
    void readForAdoption({
      read: (args) => api.call('memory.read', args),
      target,
      from,
      rowNow: () => row.current,
    }).then((outcome) => {
      if (!mounted.current || !runs.isCurrent(run)) return
      if (!outcome.ok) {
        setAdoption({ busy: false, error: outcome.error })
        // Changed or gone since the list was read: the next try names the entry here now.
        if (outcome.reloadList) onChanged()
        return
      }
      entry.replace(outcome.read)
      setAdoptedFrom(outcome.adoptedFrom)
      setBinding({ identity: outcome.identity, savedFrom: undefined })
      setAdoption(undefined)
    })
  }
  const target = view.adoptTarget
  return (
    <View style={{ gap: theme.space[3] }}>
      {entry.error && (!data || !locked) ? (
        <View style={{ gap: theme.space[2] }}>
          <ErrorText>{entry.error}</ErrorText>
          <Button
            label="Reload"
            variant="quiet"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => {
              entry.reload()
              onChanged()
            }}
          />
        </View>
      ) : null}
      {!data && !entry.error ? <Note>Loading entry…</Note> : null}
      {data && draftKey ? (
        <>
          <DocumentEditor
            document={memoryDocument(data, place)}
            label={memoryEntryName(data.store, place)}
            draftKey={draftKey}
            canWrite={canWrite}
            writeNote={write?.reason}
            locked={view.lockNotice}
            nowHere={view.nowHere}
            // The draft goes with the key it is actually kept under (a `#n`
            // slot included), not the editor's (web parity, e501a97).
            onAdopt={target ? (keptAs) => adopt(target, keptAs ?? draftKey) : undefined}
            adoption={adoption}
            draftNote={view.draftNote}
            keepDraft={view.keepDraft}
            onDiscard={() => {
              runs.retire()
              setAdoption(undefined)
              setAdoptedFrom(undefined)
            }}
            // The list names the entry's current id; the read follows it.
            onReload={onChanged}
            onSave={async (content, reviewed) => {
              guardMemorySave(locked, memoryDocument(data, place).version, reviewed)
              // The id of the entry that was read and reviewed, never the list's.
              const saved = await api.call('memory.write', memoryWrite(data, content))
              entry.replace(saved)
              setBinding(bindingAfterSave(saved.id, summary?.id))
              setAdoptedFrom(undefined)
              onChanged()
              return memoryDocument(saved, place)
            }}
          />
          {canWrite && view.deletes ? (
            // Keyed by id: if the entry here changes, an open confirmation closes
            // instead of deleting another entry. It names the text read under that
            // id, the entry the delete names.
            <DeleteEntry
              key={view.deletes.entry.id}
              entry={view.deletes.entry}
              title={view.deletes.title}
              onDeleted={onDeleted}
            />
          ) : null}
        </>
      ) : null}
    </View>
  )
}

function DeleteEntry({
  entry,
  title,
  onDeleted,
}: {
  entry: MemoryEntry
  title: string
  onDeleted: () => void
}) {
  const api = useCindlApi()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const remove = () => {
    setBusy(true)
    setError(undefined)
    api.call('memory.delete', memoryDelete(entry)).then(
      () => {
        setBusy(false)
        setConfirming(false)
        onDeleted()
      },
      (failure: unknown) => {
        setBusy(false)
        setError(describeFailure(failure, DELETE_UNCERTAIN, DELETE_REFUSED).message)
      },
    )
  }
  return (
    <>
      <Button
        label="Delete entry…"
        variant="quiet"
        style={{ alignSelf: 'flex-end' }}
        onPress={() => {
          setError(undefined)
          setConfirming(true)
        }}
      />
      <Dialog
        open={confirming}
        title="Delete this memory entry?"
        onCancel={() => {
          if (!busy) setConfirming(false)
        }}
        actions={
          <>
            <Button
              label="Keep it"
              variant="quiet"
              disabled={busy}
              onPress={() => setConfirming(false)}
            />
            <Button
              label="Delete permanently"
              variant="danger"
              disabled={busy}
              busy={busy}
              onPress={remove}
            />
          </>
        }
      >
        <Txt tone="secondary">{deleteWarning(title)}</Txt>
        {error ? (
          <Txt
            tone="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            {error}
          </Txt>
        ) : null}
      </Dialog>
    </>
  )
}
