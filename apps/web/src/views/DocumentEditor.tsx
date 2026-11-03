import { diffLines, diffStats } from '@cindl/client-core'
import { isCindlError, type VersionedDocument } from '@cindl/contracts'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './views.module.css'

/** `base` is the version the owner reviewed the draft against. */
type Stage =
  | { kind: 'view' }
  | { kind: 'edit'; draft: string }
  | { kind: 'review'; draft: string; base: string }

/**
 * Drafts kept after a save conflict or when an editor locks, by draft key, so
 * a reload (which can remount or fail) never loses what the owner wrote. A
 * draft key names the document a draft was written for, so a kept draft only
 * ever returns to that document. Cleared on save or discard.
 */
const keptDrafts = new Map<string, string>()

/** Forget every kept draft (on sign-out, so nothing outlives the session). */
export function forgetDocumentDrafts() {
  keptDrafts.clear()
}

/** Kept drafts whose key starts with `prefix`, oldest first. */
export function keptDocumentDrafts(
  prefix: string,
): Array<{ key: string; draft: string }> {
  return [...keptDrafts]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, draft]) => ({ key, draft }))
}

/** Forget one kept draft. */
export function forgetDocumentDraft(key: string) {
  keptDrafts.delete(key)
}

function Review({ before, draft }: { before: string; draft: string }) {
  const { lines, exact } = useMemo(() => diffLines(before, draft), [before, draft])
  const stats = diffStats(lines)
  return (
    <>
      <p>
        Review before saving: <strong>{stats.added}</strong> line
        {stats.added === 1 ? '' : 's'} added, <strong>{stats.removed}</strong> removed.
        {exact ? '' : ' (Large document: shown as a full replacement.)'}
      </p>
      <pre className={styles.diff} aria-label="Changes">
        {lines.map((line, index) => (
          <span key={index} className={styles.diffLine} data-kind={line.kind}>
            {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
            {line.text}
          </span>
        ))}
      </pre>
    </>
  )
}

/**
 * Owner edits go through three explicit steps: edit, review the exact diff
 * against the version that was read, confirm. The write carries that version,
 * so a document changed elsewhere in the meantime is rejected, not clobbered.
 * After a conflict the draft is kept and re-reviewed against the new version.
 */
export function DocumentEditor({
  document,
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
  /** Said above a draft in place of the kept-after-a-conflict note. */
  draftNote?: string | undefined
  /** Keep the draft under `draftKey` while it is edited, not only once locked. */
  keepDraft?: boolean
  /** The owner discarded the draft (it is forgotten under `draftKey` first). */
  onDiscard?: (() => void) | undefined
  onSave: (content: string, expectedVersion: string) => Promise<VersionedDocument>
  onReload: () => void
}) {
  const [stage, setStage] = useState<Stage>(() => {
    const kept = keptDrafts.get(draftKey)
    return kept === undefined ? { kind: 'view' } : { kind: 'edit', draft: kept }
  })
  const restored = keptDrafts.has(draftKey) && stage.kind !== 'view'
  // A locked editor keeps its draft under the key it was written for, so
  // closing it loses nothing (the owner can copy it from the list of kept
  // drafts) and it never returns to a different document. So does an editor
  // asked to keep its draft (one written for another document).
  const keptDraft =
    (locked || keepDraft) && stage.kind !== 'view' ? stage.draft : undefined
  useEffect(() => {
    if (keptDraft !== undefined) keptDrafts.set(draftKey, keptDraft)
  }, [draftKey, keptDraft])
  const [error, setError] = useState<{ message: string; conflict: boolean }>()
  const [saving, setSaving] = useState(false)
  // The text a save replaced, offered back only while the document is still
  // the version that save produced (not another entry, nor a later change).
  const [backup, setBackup] = useState<{ content: string; version: string }>()
  const lockNotice = locked ? (
    <div className={styles.section}>
      <p className={styles.error} role="alert">
        {locked}
      </p>
      {adoption?.error ? (
        <>
          <p className={styles.error} role="alert">
            {adoption.error}
          </p>
          <p className={styles.note}>Your draft was not used, and it is still kept.</p>
        </>
      ) : null}
      {adoption?.busy ? (
        <p className={styles.note} role="status">
          Reading the entry now here…
        </p>
      ) : null}
      {onAdopt && stage.kind !== 'view' ? (
        <div className={styles.actions}>
          <Button variant="quiet" disabled={Boolean(adoption?.busy)} onClick={onAdopt}>
            Use this draft for the entry now here
          </Button>
        </div>
      ) : null}
    </div>
  ) : null

  if (stage.kind === 'view')
    return (
      <div className={styles.section}>
        {lockNotice}
        <pre className={styles.doc}>{document.content}</pre>
        <p className={styles.note}>
          Read {new Date(document.readAt).toLocaleString()} from {document.source}.
          Version <code>{document.version.slice(0, 12)}</code>.
        </p>
        {backup && !locked && backup.version === document.version ? (
          <p className={styles.note}>
            The previous version is kept on this screen until you leave it.{' '}
            <Button
              variant="quiet"
              onClick={() => setStage({ kind: 'edit', draft: backup.content })}
            >
              Restore previous version
            </Button>
          </p>
        ) : backup ? (
          // Hermes keeps no backup. Once the text shown is not the version that
          // save produced, restoring would write over something else, so the
          // replaced text is only shown, to copy.
          <div className={styles.section}>
            <p className={styles.note}>
              The text your last save replaced, kept on this screen to copy:
            </p>
            <pre className={styles.doc}>{backup.content}</pre>
          </div>
        ) : null}
        <div className={styles.actions}>
          <Button variant="quiet" onClick={onReload}>
            Reload
          </Button>
          {canWrite && !locked ? (
            <Button onClick={() => setStage({ kind: 'edit', draft: document.content })}>
              Edit
            </Button>
          ) : null}
        </div>
        {writeNote ? <p className={styles.note}>{writeNote}</p> : null}
      </div>
    )

  if (stage.kind === 'edit')
    return (
      <div className={styles.section}>
        {lockNotice}
        {draftNote && !locked ? (
          <p className={styles.note} role="status">
            {draftNote}
          </p>
        ) : restored && !locked ? (
          <p className={styles.note} role="status">
            Your unsaved draft was kept. Review it against the current version before
            saving.
          </p>
        ) : null}
        <label className="visually-hidden" htmlFor="doc-editor">
          Edit {document.key}
        </label>
        <textarea
          id="doc-editor"
          className={styles.editor}
          value={stage.draft}
          readOnly={Boolean(locked)}
          spellCheck
          onChange={(event) => setStage({ kind: 'edit', draft: event.target.value })}
        />
        <div className={styles.actions}>
          <Button
            variant="quiet"
            onClick={() => {
              keptDrafts.delete(draftKey)
              setStage({ kind: 'view' })
              onDiscard?.()
            }}
          >
            Discard changes
          </Button>
          <Button
            variant="primary"
            disabled={Boolean(locked) || stage.draft === document.content}
            onClick={() =>
              setStage({ kind: 'review', draft: stage.draft, base: document.version })
            }
          >
            Review changes
          </Button>
        </div>
      </div>
    )

  const { draft, base } = stage
  // What the owner reviewed is no longer what is shown: Hermes changed it, or
  // another entry took its place. Saving needs a fresh review.
  const moved = base !== document.version
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const previous = document.content
      const saved = await onSave(draft, base)
      keptDrafts.delete(draftKey)
      setBackup({ content: previous, version: saved.version })
      setStage({ kind: 'view' })
    } catch (err) {
      if (isCindlError(err) && err.code === 'conflict') {
        keptDrafts.set(draftKey, draft)
        setError({ message: `${err.message} Your draft is kept.`, conflict: true })
      } else if (
        isCindlError(err) &&
        ['invalid', 'unsupported', 'unavailable', 'unauthenticated', 'offline'].includes(
          err.code,
        )
      )
        setError({ message: `${err.message} Nothing was saved.`, conflict: false })
      else
        setError({
          message:
            'Cindl could not confirm the save. Reload to check the current version before editing again.',
          conflict: false,
        })
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className={styles.section}>
      {lockNotice}
      <Review before={document.content} draft={draft} />
      {moved && !locked ? (
        <p className={styles.error} role="alert">
          This text changed in Hermes while you were reviewing, so the changes above are
          against the new version. Go back to editing and review your draft again before
          saving.
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error.message}
        </p>
      ) : null}
      <div className={styles.actions}>
        {error?.conflict ? (
          <Button
            onClick={() => {
              // Fetch the current version, keep the draft, and review it again against the new text.
              onReload()
              setError(undefined)
              setStage({ kind: 'edit', draft })
            }}
          >
            Reload and keep my draft
          </Button>
        ) : null}
        <Button
          variant="quiet"
          disabled={saving}
          onClick={() => setStage({ kind: 'edit', draft })}
        >
          Back to editing
        </Button>
        <Button
          variant="primary"
          disabled={saving || moved || Boolean(locked) || Boolean(error?.conflict)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Confirm and save'}
        </Button>
      </div>
    </div>
  )
}
