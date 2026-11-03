import { useCan, useCapability, useCindlApi } from '@cindl/client-react'
import {
  CindlError,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryStore,
} from '@cindl/contracts'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { Dialog } from '../overlay/Sheet.tsx'
import { describeFailure } from '../talk/failures.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, Empty, ErrorText, Note, Txt } from '../ui/primitives.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { forgetDocumentDraft, keptDocumentDrafts } from '../views/drafts.ts'
import { useResource } from '../views/useResource.ts'
import {
  bindingLocked,
  DELETE_REFUSED,
  DELETE_UNCERTAIN,
  deleteWarning,
  entryAt,
  followList,
  guardMemorySave,
  keepsVanishedRow,
  LOCKED_NOTICE,
  MEMORY_DRAFT_PREFIX,
  memoryDelete,
  memoryDocument,
  memoryDraftKey,
  memoryEntryName,
  memoryStores,
  memoryWrite,
  orphanDrafts,
  placeOf,
  type Binding,
  type MemoryPlace,
} from './memory.ts'

/**
 * Hermes's memory entries, opened one at a time (web parity:
 * apps/web/src/library/MemoryEntries.tsx). An open editor stays bound to the
 * entry it read: edits go through the reviewed diff and the write names that
 * entry's id; a delete asks first, names the entry and is permanent. Drafts
 * are kept under the entry they were written for, never its place.
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
                        <Txt style={{ flex: 1 }}>Removed in Hermes</Txt>
                        <Button
                          label="Close"
                          accessibilityLabel="Close the removed memory entry"
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
  onChanged,
  onDeleted,
}: {
  store: MemoryStore
  /** The entry the list shows at this place; missing once it vanished. */
  summary: MemoryEntrySummary | undefined
  /** 1-based position in its store, as the row shows it. */
  place: number
  onChanged: () => void
  onDeleted: () => void
}) {
  const api = useCindlApi()
  const theme = useTheme()
  const canWrite = useCan('memory.text')
  const write = useCapability('memory.text')
  // Keyed by place: a save gives the entry a new id, and a new key would drop the
  // editor (and its "Restore previous version") until the read finished.
  const entry = useResource(
    () =>
      summary
        ? api.call('memory.read', { id: summary.id })
        : Promise.reject(
            new CindlError('not-found', 'This entry was removed in Hermes.'),
          ),
    `memory:${store}:${place}`,
    'This entry could not be loaded. It may have changed; reload the list.',
  )
  // The editor stays bound to the entry it read (memory.ts followList): it
  // follows the same text under a new number and locks on anything else, until
  // the owner explicitly uses the draft for the entry now here.
  const [binding, setBinding] = useState<Binding>('following')
  const adopting = typeof binding === 'object' ? binding.adopting : undefined
  const locked = bindingLocked(binding, entry.data?.id)
  // Once per change of the entry listed here (adjusted while rendering, as React
  // advises for state that follows a prop): deriving the lock from the list on
  // every render would let a later reload unlock it onto a different entry.
  const [listed, setListed] = useState(summary?.id)
  if (listed !== summary?.id) {
    setListed(summary?.id)
    const next = followList(binding, entry.data?.id, summary?.id, Boolean(entry.error))
    if (next.binding !== binding) setBinding(next.binding)
    if (next.reread) entry.reload()
  }
  const data = entry.data
  const draftKey = data ? memoryDraftKey(data.id) : undefined
  return (
    <View style={{ gap: theme.space[3] }}>
      {entry.error && !locked ? (
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
            locked={locked ? LOCKED_NOTICE : undefined}
            onAdopt={
              summary && !adopting
                ? () => {
                    // The owner chose the entry now here: the draft moves to it, and
                    // the editor stays locked until that entry is read.
                    forgetDocumentDraft(draftKey)
                    setBinding({ adopting: summary.id })
                    entry.reload()
                  }
                : undefined
            }
            // The list names the entry's current id; the read follows it.
            onReload={onChanged}
            onSave={async (content, reviewed) => {
              guardMemorySave(locked, memoryDocument(data, place).version, reviewed)
              // The id of the entry that was read and reviewed, never the list's.
              const saved = await api.call('memory.write', memoryWrite(data, content))
              entry.replace(saved)
              onChanged()
              return memoryDocument(saved, place)
            }}
          />
          {canWrite && !locked ? (
            // Keyed by id: if the entry here changes, an open confirmation closes
            // instead of deleting another entry.
            <DeleteEntry
              key={data.id}
              entry={data}
              title={summary?.title ?? data.content.split('\n')[0] ?? ''}
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
