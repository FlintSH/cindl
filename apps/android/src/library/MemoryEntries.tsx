import { useCan, useCapability, useCindlApi } from '@cindl/client-react'
import type { MemoryEntry, MemoryEntrySummary } from '@cindl/contracts'
import { useEffect, useEffectEvent, useState } from 'react'
import { Text, View } from 'react-native'
import { Dialog } from '../overlay/Sheet.tsx'
import { describeFailure } from '../talk/failures.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, Empty, ErrorText, Note, Txt } from '../ui/primitives.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { useResource } from '../views/useResource.ts'
import {
  DELETE_REFUSED,
  DELETE_UNCERTAIN,
  DELETE_WARNING,
  entryAt,
  memoryDelete,
  memoryDocument,
  memoryEntryName,
  memoryStores,
  memoryWrite,
  placeOf,
  type MemoryPlace,
} from './memory.ts'

/**
 * Hermes's memory entries, opened one at a time (web parity). Editing goes
 * through the document editor's reviewed diff; deleting asks first and says
 * it is permanent. Both name the id of the entry that was read.
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
  const entries = list.data ?? []
  const selected = open ? entryAt(entries, open) : undefined
  return (
    <View style={{ gap: theme.space[4] }}>
      {list.error ? <ErrorText>{list.error}</ErrorText> : null}
      {!list.data && !list.error ? <Note>Loading memory entries…</Note> : null}
      {list.data && !entries.length ? (
        <Empty>Hermes has no memory entries yet.</Empty>
      ) : null}
      {memoryStores.map(({ store, title, hint }) => {
        const inStore = entries.filter((entry) => entry.store === store)
        if (!inStore.length) return null
        return (
          <View key={store} style={{ gap: theme.space[2] }}>
            <Text
              accessibilityRole="header"
              style={[
                theme.text.ui,
                { fontFamily: theme.fonts.semibold, color: theme.colors.text },
              ]}
            >
              {title}
            </Text>
            <Note>{hint}</Note>
            {inStore.map((entry, index) => (
              // Keyed by place, not id: a saved entry gets a new id, and a remount
              // would drop the editor's "Restore previous version".
              <EntryRow
                key={`${store}:${index}`}
                entry={entry}
                place={index + 1}
                open={selected?.id === entry.id}
                onToggle={() =>
                  setOpen(
                    selected?.id === entry.id ? undefined : placeOf(entries, entry.id),
                  )
                }
                onChanged={list.reload}
                onDeleted={() => {
                  setOpen(undefined)
                  list.reload()
                }}
              />
            ))}
          </View>
        )
      })}
    </View>
  )
}

function EntryRow({
  entry,
  place,
  open,
  onToggle,
  onChanged,
  onDeleted,
}: {
  entry: MemoryEntrySummary
  place: number
  open: boolean
  onToggle: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const theme = useTheme()
  const name = memoryEntryName(entry.store, place)
  return (
    <View
      style={{
        gap: theme.space[3],
        padding: theme.space[3],
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surface,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        {/* Open, the editor shows the text; the row names the entry instead. */}
        <Txt style={{ flex: 1 }}>
          {open
            ? `${name.charAt(0).toUpperCase()}${name.slice(1)}`
            : `${entry.preview}${entry.truncated ? '…' : ''}`}
        </Txt>
        <Button
          label={open ? 'Close' : 'Open'}
          accessibilityLabel={`${open ? 'Close' : 'Open'} memory entry: ${entry.title}`}
          variant="quiet"
          onPress={onToggle}
        />
      </View>
      {open ? (
        <EntryEditor
          summary={entry}
          place={place}
          onChanged={onChanged}
          onDeleted={onDeleted}
        />
      ) : null}
    </View>
  )
}

function EntryEditor({
  summary,
  place,
  onChanged,
  onDeleted,
}: {
  summary: MemoryEntrySummary
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
    () => api.call('memory.read', { id: summary.id }),
    `memory:${summary.store}:${place}`,
    'This entry could not be loaded. It may have changed; reload the list.',
  )
  // When the list shows another id at this place (a change made elsewhere), read
  // what Hermes now has there, keeping the editor and any draft while it loads.
  // After a save here the list catches up to the saved id: no second read.
  const followList = useEffectEvent((listed: string) => {
    if (entry.data && entry.data.id !== listed) entry.reload()
  })
  useEffect(() => followList(summary.id), [summary.id])
  const data = entry.data
  return (
    <View style={{ gap: theme.space[3] }}>
      {entry.error ? <ErrorText>{entry.error}</ErrorText> : null}
      {!data && !entry.error ? <Note>Loading entry…</Note> : null}
      {data ? (
        <>
          <DocumentEditor
            document={memoryDocument(data, place)}
            label={memoryEntryName(data.store, place)}
            canWrite={canWrite}
            writeNote={write?.reason}
            onReload={() => {
              entry.reload()
              onChanged()
            }}
            onSave={async (content) => {
              // The id of the entry that was read and reviewed, never the list's.
              const saved = await api.call('memory.write', memoryWrite(data, content))
              entry.replace(saved)
              onChanged()
              return memoryDocument(saved, place)
            }}
          />
          {canWrite ? <DeleteEntry entry={data} onDeleted={onDeleted} /> : null}
        </>
      ) : null}
    </View>
  )
}

function DeleteEntry({
  entry,
  onDeleted,
}: {
  entry: MemoryEntry
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
        <Txt tone="secondary">{DELETE_WARNING}</Txt>
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
