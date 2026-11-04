import { diffLines, diffStats } from '@cindl/client-core'
import { isCindlError, type VersionedDocument } from '@cindl/contracts'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  Text,
  TextInput,
  View,
  type HostInstance,
  type TextInputInstance,
} from 'react-native'
import { useBackHandler, useDestinationActive } from '../nav/NavProvider.tsx'
import { giveKeyboardFocus } from '../overlay/keyboardFocus.ts'
import { ownerMoves } from '../overlay/opener.ts'
import { Dialog } from '../overlay/Sheet.tsx'
import { describeFailure, NOT_APPLIED, SAVE_UNCERTAIN } from '../talk/failures.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, Note, Txt } from '../ui/primitives.tsx'
import { keptDrafts } from './drafts.ts'
import {
  draftNotice,
  focusAfterLock,
  initialStage,
  KEPT_BESIDE,
  KEPT_OFFER,
  keepKey,
  keptDraft,
  keptState,
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
  locked: lockedBy,
  onAdopt,
  adoption,
  nowHere,
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
  locked?: string | ((keptAs: string | undefined) => string) | undefined
  /**
   * The owner's explicit choice to use a locked draft for the document now
   * shown. Without it, nothing written for one document reaches another.
   */
  onAdopt?: ((keptAs: string | undefined) => void) | undefined
  /** An adoption under way (`busy`) or refused (`error`); the draft stays kept either way. */
  adoption?: { busy: boolean; error?: string | undefined } | undefined
  /** What a locked editor's adoption would use the draft for, said beside the button. */
  nowHere?: string | undefined
  /** Said above a draft in place of the kept-draft note. */
  draftNote?: string | undefined
  /** Keep the draft while it is edited, not only once locked. */
  keepDraft?: boolean
  /** The owner discarded the draft (its kept copy, if any, is forgotten first). */
  onDiscard?: (() => void) | undefined
  onSave: (content: string, expectedVersion: string) => Promise<VersionedDocument>
  onReload: () => void
}) {
  const theme = useTheme()
  const active = useDestinationActive()
  const [stage, setStage] = useState<Stage>(() =>
    initialStage(keptDrafts.get(draftKey), draftKey),
  )
  const [, setKeptSeen] = useState(0)
  // Every draft in the box records the kept slot it came from or was filed
  // under (`keptAs`); a save or discard forgets that slot only. This document's
  // kept draft is restored when the box holds it, and offered when it does not:
  // nothing done in the box replaces or forgets it.
  const keptAs = stage.kind === 'view' ? undefined : stage.keptAs
  // Given as a function, the lock is told where the box's draft is kept, so it
  // can say where that draft goes when the editor closes.
  const locked = typeof lockedBy === 'function' ? lockedBy(keptAs) : lockedBy
  // Where the box's draft is kept now. A save or conflict that ends after the
  // editor locked (the lock files the draft) acts on that key, not on the one
  // the draft had when the save started (web parity, e501a97).
  const keptAsNow = useRef(keptAs)
  useLayoutEffect(() => {
    keptAsNow.current = keptAs
  })
  const { restored, offered } = keptState(keptDrafts, draftKey, stage)
  // A locked editor keeps its draft, so closing it loses nothing (it is listed
  // to copy) and it never returns to another document. So does an editor asked
  // to keep its draft (one written for another). A draft kept for the first time
  // is filed once (adjusted while rendering): under this document's key, or
  // beside the different draft already there (`<key>#2`).
  const keep = keptDraft(locked, keepDraft, stage)
  if (keep !== undefined && keptAs === undefined && stage.kind !== 'view')
    setStage({ ...stage, keptAs: keepKey(keptDrafts, draftKey, undefined, keep) })
  useEffect(() => {
    if (keep !== undefined && keptAs !== undefined) keptDrafts.set(keptAs, keep)
  }, [keptAs, keep])
  // TalkBack focus follows the lock: into the draft when it lifts (an adoption
  // completed), onto the notice when it starts (it takes Edit and Delete away).
  const box = useRef<TextInputInstance>(null)
  const edit = useRef<HostInstance | null>(null)
  // A step replaces the control the owner pressed (or the step system back
  // left): TalkBack focus and a keyboard's go to what took its place, the lock
  // notice while locked, else the draft, the review, or Edit (Reload when
  // there is no Edit). A step that lands later (a save) gives none once the
  // owner has moved meanwhile (opener.ts ownerMoves), or when this editor's
  // destination is no longer the one shown (web parity, cb9caeb).
  const reload = useRef<HostInstance | null>(null)
  const reviewText = useRef<HostInstance | null>(null)
  const stepMoves = useRef<number>(undefined)
  /** A step whose focus moves once the stage it leads to is on screen. */
  const step = () => {
    stepMoves.current = ownerMoves()
  }
  // A step that keeps the stage (Discard the draft) moves focus once it renders.
  const [stepped, setStepped] = useState(0)
  const stepInPlace = () => {
    step()
    setStepped((count) => count + 1)
  }
  const shown = useRef(active)
  useLayoutEffect(() => {
    shown.current = active
  })
  const lockText = useRef<HostInstance>(null)
  const isLocked = Boolean(locked)
  const wasLocked = useRef(isLocked)
  useEffect(() => {
    const target = focusAfterLock(wasLocked.current, isLocked)
    wasLocked.current = isLocked
    if (!target) return
    const timer = setTimeout(() => {
      // Hidden, its screen is not the one TalkBack is on (review 3f7a8a69, R4).
      if (!shown.current) return
      const node = target === 'draft' ? box.current : lockText.current
      if (node) AccessibilityInfo.sendAccessibilityEvent(node, 'focus')
    }, 60)
    return () => clearTimeout(timer)
  }, [isLocked])
  useEffect(() => {
    const moves = stepMoves.current
    if (moves === undefined) return
    stepMoves.current = undefined
    const timer = setTimeout(() => {
      // Hidden, its controls are closed to a keyboard's focus, and the focus
      // module would climb out to the destination on screen.
      if (!shown.current || ownerMoves() !== moves) return
      // The lock notice is there only while the editor is locked (lockPanel).
      const node =
        lockText.current ??
        box.current ??
        reviewText.current ??
        edit.current ??
        reload.current
      if (!node) return
      AccessibilityInfo.sendAccessibilityEvent(node, 'focus')
      giveKeyboardFocus(node)
    }, 60)
    return () => clearTimeout(timer)
  }, [stage.kind, stepped])
  const [failure, setFailure] = useState<{ message: string; conflict: boolean }>()
  const [saving, setSaving] = useState(false)
  // The text a save replaced, with the version that save produced.
  const [backup, setBackup] = useState<{ content: string; version: string }>()
  const [discarding, setDiscarding] = useState(false)
  const dirty = stage.kind !== 'view' && stage.draft !== document.content
  const panel = lockPanel({
    locked,
    canAdopt: Boolean(onAdopt),
    stage,
    adoption,
    nowHere,
  })
  const lockNotice = panel ? (
    <View style={{ gap: theme.space[2] }}>
      {panel.alerts.map((alert, index) => (
        <Text
          key={alert}
          ref={index === 0 ? lockText : undefined}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={[theme.text.ui, { color: theme.colors.danger }]}
        >
          {alert}
        </Text>
      ))}
      {panel.nowHere ? <Note>{panel.nowHere}</Note> : null}
      {panel.note ? <Note>{panel.note}</Note> : null}
      {panel.busy ? (
        <Txt variant="label" tone="tertiary" accessibilityLiveRegion="polite">
          {panel.busy}
        </Txt>
      ) : null}
      {panel.reload || (panel.adopt && onAdopt) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          {/* The view stage has its own Reload; here the list may be stale. */}
          {panel.reload ? (
            <Button label="Reload" variant="quiet" onPress={onReload} />
          ) : null}
          {panel.adopt && onAdopt ? (
            <Button
              label="Use this draft for the entry now here"
              variant="quiet"
              disabled={panel.adopt.disabled}
              {...(panel.adopt.hint ? { accessibilityHint: panel.adopt.hint } : {})}
              onPress={() => onAdopt(keptAs)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  ) : null
  const notice = draftNotice({ draftNote, restored, locked })

  const leaveEditing = () => {
    if (dirty) setDiscarding(true)
    else {
      step()
      setStage({ kind: 'view' })
    }
  }

  useBackHandler(
    () => {
      if (stage.kind === 'review') {
        step()
        setStage({ kind: 'edit', draft: stage.draft, keptAs: stage.keptAs })
      } else leaveEditing()
      return true
    },
    active && stage.kind !== 'view' && !saving,
  )

  const discardDialog = (
    <Dialog
      open={discarding}
      title="Discard your changes?"
      onCancel={() => setDiscarding(false)}
      // System back opens it (no control did): focus goes back to the draft, or,
      // once the draft is discarded, to Edit.
      returnFocus={() => box.current ?? edit.current}
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
              if (keptAs !== undefined) keptDrafts.delete(keptAs)
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
        {offered !== undefined && !locked ? (
          <View style={{ gap: theme.space[2] }}>
            <Txt variant="label" tone="secondary" accessibilityLiveRegion="polite">
              {KEPT_OFFER}
            </Txt>
            <Text selectable style={[theme.text.code, { color: theme.colors.text }]}>
              {offered}
            </Text>
            {actions(
              <>
                <Button
                  label="Discard the draft"
                  variant="quiet"
                  onPress={() => {
                    // Its offer goes with it: focus to Edit (web parity, e395d03).
                    stepInPlace()
                    keptDrafts.delete(draftKey)
                    setKeptSeen((value) => value + 1)
                  }}
                />
                {canWrite ? (
                  <Button
                    label="Continue the draft"
                    onPress={() => {
                      step()
                      setFailure(undefined)
                      setStage({ kind: 'edit', draft: offered, keptAs: draftKey })
                    }}
                  />
                ) : null}
              </>,
            )}
          </View>
        ) : null}
        {previous === 'restore' && backup ? (
          <View style={{ gap: theme.space[2] }}>
            <Note>The previous version is kept on this screen until you leave it.</Note>
            <Button
              label="Restore previous version"
              variant="quiet"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => {
                step()
                // A refusal is about another draft (review 3f7a8a69, R2).
                setFailure(undefined)
                setStage({ kind: 'edit', draft: backup.content })
              }}
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
            <Button ref={reload} label="Reload" variant="quiet" onPress={onReload} />
            {canWrite && !locked ? (
              <Button
                ref={edit}
                label="Edit"
                onPress={() => {
                  step()
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
        {offered !== undefined && !locked ? <Note>{KEPT_BESIDE}</Note> : null}
        <TextInput
          ref={box}
          accessibilityLabel={`Edit ${document.key}`}
          value={stage.draft}
          editable={!locked}
          onChangeText={(draft) =>
            setStage({ kind: 'edit', draft, keptAs: stage.keptAs })
          }
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
                step()
                if (stage.keptAs !== undefined) keptDrafts.delete(stage.keptAs)
                setFailure(undefined)
                setStage({ kind: 'view' })
                onDiscard?.()
              }}
            />
            <Button
              label="Review changes"
              variant="primary"
              disabled={Boolean(locked) || stage.draft === document.content}
              onPress={() => {
                step()
                setStage(reviewStage(stage.draft, document, stage.keptAs))
              }}
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
      // Only this draft's kept copy, wherever it is filed now; another kept
      // draft for the document stays.
      const filed = keptAsNow.current
      if (filed !== undefined) keptDrafts.delete(filed)
      setBackup({ content: previous, version: saved.version })
      setStage({ kind: 'view' })
    } catch (error) {
      if (isCindlError(error) && error.code === 'conflict') {
        const key = keepKey(keptDrafts, draftKey, keptAsNow.current, draft)
        keptDrafts.set(key, draft)
        setStage({ kind: 'review', draft, base, keptAs: key })
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
      <Txt ref={reviewText}>
        {`Review before saving: ${stats.added} line${stats.added === 1 ? '' : 's'} added, ${stats.removed} removed.${
          exact ? '' : ' (Large document: shown as a full replacement.)'
        }`}
      </Txt>
      <View
        collapsable={false}
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
                step()
                onReload()
                setFailure(undefined)
                setStage({ kind: 'edit', draft, keptAs })
              }}
            />
          ) : null}
          <Button
            label="Back to editing"
            variant="quiet"
            disabled={saving}
            onPress={() => {
              step()
              setStage({ kind: 'edit', draft, keptAs })
            }}
          />
          <Button
            label={saving ? 'Saving…' : 'Confirm and save'}
            variant="primary"
            disabled={saving || moved || Boolean(locked) || Boolean(failure?.conflict)}
            busy={saving}
            onPress={() => {
              step()
              void save()
            }}
          />
        </>,
      )}
    </View>
  )
}
