import { diffLines, diffStats } from '@cindl/client-core'
import { isCindlError, type VersionedDocument } from '@cindl/contracts'
import { useEffect, useState, type ReactNode } from 'react'
import { Text, TextInput, View } from 'react-native'
import { useBackHandler, useDestinationActive } from '../nav/NavProvider.tsx'
import { Dialog } from '../overlay/Sheet.tsx'
import { describeFailure, NOT_APPLIED, SAVE_UNCERTAIN } from '../talk/failures.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, Note, Txt } from '../ui/primitives.tsx'
import { keptDrafts } from './drafts.ts'
import {
  draftNotice,
  initialStage,
  keptDraft,
  lockPanel,
  previousTextOffer,
  reviewMoved,
  reviewStage,
  type Stage,
} from './editorModel.ts'

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
  draftKey = document.key,
  canWrite,
  writeNote,
  locked,
  onAdopt,
  adoption,
  draftNote,
  keepDraft = false,
  onDiscard,
  onSave,
  onReload,
}: {
  document: VersionedDocument
  label: string
  /** Where a kept draft lives: the identity of the document it was written for. */
  draftKey?: string
  canWrite: boolean
  writeNote?: string | undefined
  /**
   * Why this editor may no longer save (its document is gone, or the one shown
   * may not be it). The draft stays visible, read-only, and is kept.
   */
  locked?: string | undefined
  /**
   * The owner's explicit choice to use a locked draft for the document now
   * shown. Without it, nothing written for one document reaches another.
   */
  onAdopt?: (() => void) | undefined
  /** An adoption under way (`busy`) or refused (`error`); the draft stays kept either way. */
  adoption?: { busy: boolean; error?: string | undefined } | undefined
  /** Said above a draft in place of the kept-draft note. */
  draftNote?: string | undefined
  /** Keep the draft under `draftKey` while it is edited, not only once locked. */
  keepDraft?: boolean
  /** The owner discarded the draft (it is forgotten under `draftKey` first). */
  onDiscard?: (() => void) | undefined
  onSave: (content: string, expectedVersion: string) => Promise<VersionedDocument>
  onReload: () => void
}) {
  const theme = useTheme()
  const active = useDestinationActive()
  const [stage, setStage] = useState<Stage>(() => initialStage(keptDrafts.get(draftKey)))
  const restored = keptDrafts.has(draftKey) && stage.kind !== 'view'
  // A locked editor keeps its draft under the key it was written for, so closing
  // it loses nothing (it is listed to copy) and it never returns to another
  // document. So does an editor asked to keep its draft (one written for another).
  const keep = keptDraft(locked, keepDraft, stage)
  useEffect(() => {
    if (keep !== undefined) keptDrafts.set(draftKey, keep)
  }, [draftKey, keep])
  const [failure, setFailure] = useState<{ message: string; conflict: boolean }>()
  const [saving, setSaving] = useState(false)
  // The text a save replaced, with the version that save produced.
  const [backup, setBackup] = useState<{ content: string; version: string }>()
  const [discarding, setDiscarding] = useState(false)
  const dirty = stage.kind !== 'view' && stage.draft !== document.content
  const panel = lockPanel({ locked, canAdopt: Boolean(onAdopt), stage, adoption })
  const lockNotice = panel ? (
    <View style={{ gap: theme.space[2] }}>
      {panel.alerts.map((alert) => (
        <Txt
          key={alert}
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          {alert}
        </Txt>
      ))}
      {panel.note ? <Note>{panel.note}</Note> : null}
      {panel.busy ? (
        <Txt variant="label" tone="tertiary" accessibilityLiveRegion="polite">
          {panel.busy}
        </Txt>
      ) : null}
      {panel.adopt && onAdopt ? (
        <Button
          label="Use this draft for the entry now here"
          variant="quiet"
          disabled={panel.adopt.disabled}
          style={{ alignSelf: 'flex-start' }}
          onPress={onAdopt}
        />
      ) : null}
    </View>
  ) : null
  const notice = draftNotice({ draftNote, restored, locked })

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
              keptDrafts.delete(draftKey)
              setFailure(undefined)
              setStage({ kind: 'view' })
              onDiscard?.()
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

  if (stage.kind === 'view') {
    const previous = previousTextOffer(backup, document, locked)
    return (
      <View style={{ gap: theme.space[3] }}>
        {lockNotice}
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
        {previous === 'restore' && backup ? (
          <View style={{ gap: theme.space[2] }}>
            <Note>The previous version is kept on this screen until you leave it.</Note>
            <Button
              label="Restore previous version"
              variant="quiet"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => setStage({ kind: 'edit', draft: backup.content })}
            />
          </View>
        ) : previous === 'copy' && backup ? (
          // Restoring now would write over something else: the text is only shown.
          <View style={{ gap: theme.space[2] }}>
            <Note>The text your last save replaced, kept on this screen to copy:</Note>
            <Text selectable style={[theme.text.code, { color: theme.colors.text }]}>
              {backup.content}
            </Text>
          </View>
        ) : null}
        {actions(
          <>
            <Button label="Reload" variant="quiet" onPress={onReload} />
            {canWrite && !locked ? (
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
  }

  if (stage.kind === 'edit')
    return (
      <View style={{ gap: theme.space[3] }}>
        {lockNotice}
        {notice ? (
          <Txt variant="label" tone="secondary" accessibilityLiveRegion="polite">
            {notice}
          </Txt>
        ) : null}
        <TextInput
          accessibilityLabel={`Edit ${document.key}`}
          value={stage.draft}
          editable={!locked}
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
                keptDrafts.delete(draftKey)
                setFailure(undefined)
                setStage({ kind: 'view' })
                onDiscard?.()
              }}
            />
            <Button
              label="Review changes"
              variant="primary"
              disabled={Boolean(locked) || stage.draft === document.content}
              onPress={() => setStage(reviewStage(stage.draft, document))}
            />
          </>,
        )}
        {discardDialog}
      </View>
    )

  const { draft, base } = stage
  // What the owner reviewed is no longer what is shown: saving needs a fresh review.
  const moved = reviewMoved(base, document)
  const { lines, exact } = diffLines(document.content, draft)
  const stats = diffStats(lines)
  const save = async () => {
    setSaving(true)
    setFailure(undefined)
    try {
      const previous = document.content
      const saved = await onSave(draft, base)
      keptDrafts.delete(draftKey)
      setBackup({ content: previous, version: saved.version })
      setStage({ kind: 'view' })
    } catch (error) {
      if (isCindlError(error) && error.code === 'conflict') {
        keptDrafts.set(draftKey, draft)
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
      {lockNotice}
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
      {moved && !locked ? (
        <Txt tone="danger" accessibilityRole="alert" accessibilityLiveRegion="assertive">
          This text changed in Hermes while you were reviewing, so the changes above are
          against the new version. Go back to editing and review your draft again before
          saving.
        </Txt>
      ) : null}
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
            disabled={saving || moved || Boolean(locked) || Boolean(failure?.conflict)}
            busy={saving}
            onPress={() => void save()}
          />
        </>,
      )}
    </View>
  )
}
