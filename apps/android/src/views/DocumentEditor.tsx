import { diffLines, diffStats } from '@cindl/client-core'
import { isCindlError, type VersionedDocument } from '@cindl/contracts'
import { useState, type ReactNode } from 'react'
import { Text, TextInput, View } from 'react-native'
import { useBackHandler, useDestinationActive } from '../nav/NavProvider.tsx'
import { Dialog } from '../overlay/Sheet.tsx'
import { describeFailure, NOT_APPLIED, SAVE_UNCERTAIN } from '../talk/failures.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, Note, Txt } from '../ui/primitives.tsx'
import { keptDrafts } from './drafts.ts'

type Stage =
  { kind: 'view' } | { kind: 'edit'; draft: string } | { kind: 'review'; draft: string }

/**
 * Owner edits go through three explicit steps: edit, review the exact diff
 * against the version that was read, confirm. The write carries that
 * version, so a document changed elsewhere in the meantime is rejected, not
 * clobbered; after a conflict the draft is kept and reviewed again against
 * the new version. System back steps out of review, and unsaved edits are
 * only dropped by "Discard changes" or after a confirmation.
 */
export function DocumentEditor({
  document,
  label,
  canWrite,
  writeNote,
  onSave,
  onReload,
}: {
  document: VersionedDocument
  label: string
  canWrite: boolean
  writeNote?: string | undefined
  onSave: (content: string, expectedVersion: string) => Promise<VersionedDocument>
  onReload: () => void
}) {
  const theme = useTheme()
  const active = useDestinationActive()
  const [stage, setStage] = useState<Stage>(() => {
    const kept = keptDrafts.get(document.key)
    return kept === undefined ? { kind: 'view' } : { kind: 'edit', draft: kept }
  })
  const restored = keptDrafts.has(document.key) && stage.kind !== 'view'
  const [failure, setFailure] = useState<{ message: string; conflict: boolean }>()
  const [saving, setSaving] = useState(false)
  const [backup, setBackup] = useState<string>()
  const [discarding, setDiscarding] = useState(false)
  const dirty = stage.kind !== 'view' && stage.draft !== document.content

  const leaveEditing = () => {
    if (dirty) setDiscarding(true)
    else setStage({ kind: 'view' })
  }

  useBackHandler(
    () => {
      if (stage.kind === 'review') setStage({ kind: 'edit', draft: stage.draft })
      else leaveEditing()
      return true
    },
    active && stage.kind !== 'view' && !saving,
  )

  const discardDialog = (
    <Dialog
      open={discarding}
      title="Discard your changes?"
      onCancel={() => setDiscarding(false)}
      actions={
        <>
          <Button
            label="Keep editing"
            variant="quiet"
            onPress={() => setDiscarding(false)}
          />
          <Button
            label="Discard"
            variant="danger"
            onPress={() => {
              setDiscarding(false)
              keptDrafts.delete(document.key)
              setFailure(undefined)
              setStage({ kind: 'view' })
            }}
          />
        </>
      }
    >
      <Txt tone="secondary">{`Your edits to ${label} have not been saved.`}</Txt>
    </Dialog>
  )

  const actions = (children: ReactNode) => (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: theme.space[2],
      }}
    >
      {children}
    </View>
  )

  if (stage.kind === 'view')
    return (
      <View style={{ gap: theme.space[3] }}>
        <View
          style={{
            padding: theme.space[4],
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface,
          }}
        >
          <Text selectable style={[theme.text.code, { color: theme.colors.text }]}>
            {document.content}
          </Text>
        </View>
        <Note>
          {`Read ${new Date(document.readAt).toLocaleString()} from ${document.source}. Version ${document.version.slice(0, 12)}.`}
        </Note>
        {backup !== undefined ? (
          <View style={{ gap: theme.space[2] }}>
            <Note>The previous version is kept on this screen until you leave it.</Note>
            <Button
              label="Restore previous version"
              variant="quiet"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => setStage({ kind: 'edit', draft: backup })}
            />
          </View>
        ) : null}
        {actions(
          <>
            <Button label="Reload" variant="quiet" onPress={onReload} />
            {canWrite ? (
              <Button
                label="Edit"
                onPress={() => {
                  setFailure(undefined)
                  setStage({ kind: 'edit', draft: document.content })
                }}
              />
            ) : null}
          </>,
        )}
        {writeNote ? <Note>{writeNote}</Note> : null}
      </View>
    )

  if (stage.kind === 'edit')
    return (
      <View style={{ gap: theme.space[3] }}>
        {restored ? (
          <Txt variant="label" tone="secondary" accessibilityLiveRegion="polite">
            Your unsaved draft was kept after the conflict. Review it against the current
            version before saving.
          </Txt>
        ) : null}
        <TextInput
          accessibilityLabel={`Edit ${document.key}`}
          value={stage.draft}
          onChangeText={(draft) => setStage({ kind: 'edit', draft })}
          multiline
          autoCorrect={false}
          spellCheck
          textAlignVertical="top"
          style={[
            theme.text.code,
            {
              minHeight: 288,
              padding: theme.space[4],
              borderWidth: 1,
              borderColor: theme.colors.borderStrong,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceRaised,
              color: theme.colors.text,
            },
          ]}
        />
        {actions(
          <>
            <Button
              label="Discard changes"
              variant="quiet"
              onPress={() => {
                keptDrafts.delete(document.key)
                setFailure(undefined)
                setStage({ kind: 'view' })
              }}
            />
            <Button
              label="Review changes"
              variant="primary"
              disabled={stage.draft === document.content}
              onPress={() => setStage({ kind: 'review', draft: stage.draft })}
            />
          </>,
        )}
        {discardDialog}
      </View>
    )

  const draft = stage.draft
  const { lines, exact } = diffLines(document.content, draft)
  const stats = diffStats(lines)
  const save = async () => {
    setSaving(true)
    setFailure(undefined)
    try {
      const previous = document.content
      await onSave(draft, document.version)
      keptDrafts.delete(document.key)
      setBackup(previous)
      setStage({ kind: 'view' })
    } catch (error) {
      if (isCindlError(error) && error.code === 'conflict') {
        keptDrafts.set(document.key, draft)
        setFailure({ message: `${error.message} Your draft is kept.`, conflict: true })
      } else {
        const copy = describeFailure(error, SAVE_UNCERTAIN, NOT_APPLIED)
        setFailure({
          message: copy.certain ? `${copy.message} Nothing was saved.` : copy.message,
          conflict: false,
        })
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <View style={{ gap: theme.space[3] }}>
      <Txt>
        {`Review before saving: ${stats.added} line${stats.added === 1 ? '' : 's'} added, ${stats.removed} removed.${
          exact ? '' : ' (Large document: shown as a full replacement.)'
        }`}
      </Txt>
      <View
        accessibilityLabel="Changes"
        style={{
          paddingVertical: theme.space[2],
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surface,
        }}
      >
        {lines.map((line, index) => (
          <Text
            key={index}
            accessibilityLabel={`${
              line.kind === 'added'
                ? 'Added'
                : line.kind === 'removed'
                  ? 'Removed'
                  : 'Unchanged'
            }: ${line.text || 'blank line'}`}
            style={[
              theme.text.code,
              {
                paddingHorizontal: theme.space[3],
                color:
                  line.kind === 'added'
                    ? theme.colors.success
                    : line.kind === 'removed'
                      ? theme.colors.danger
                      : theme.colors.text,
                backgroundColor:
                  line.kind === 'added'
                    ? theme.colors.successSubtle
                    : line.kind === 'removed'
                      ? theme.colors.dangerSubtle
                      : 'transparent',
              },
            ]}
          >
            {`${line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}${line.text}`}
          </Text>
        ))}
      </View>
      {failure ? (
        <Txt tone="danger" accessibilityRole="alert" accessibilityLiveRegion="assertive">
          {failure.message}
        </Txt>
      ) : null}
      {actions(
        <>
          {failure?.conflict ? (
            <Button
              label="Reload and keep my draft"
              onPress={() => {
                // Fetch the current version, keep the draft, and review it again against the new text.
                onReload()
                setFailure(undefined)
                setStage({ kind: 'edit', draft })
              }}
            />
          ) : null}
          <Button
            label="Back to editing"
            variant="quiet"
            disabled={saving}
            onPress={() => setStage({ kind: 'edit', draft })}
          />
          <Button
            label={saving ? 'Saving…' : 'Confirm and save'}
            variant="primary"
            disabled={saving || Boolean(failure?.conflict)}
            busy={saving}
            onPress={() => void save()}
          />
        </>,
      )}
    </View>
  )
}
