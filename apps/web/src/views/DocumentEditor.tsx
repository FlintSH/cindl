import { diffLines, diffStats } from '@cindl/client-core'
import { isCindlError, type VersionedDocument } from '@cindl/contracts'
import { useMemo, useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './views.module.css'

/** `base` is the version the owner reviewed the draft against. */
type Stage =
  | { kind: 'view' }
  | { kind: 'edit'; draft: string }
  | { kind: 'review'; draft: string; base: string }

/**
 * Drafts kept after a save conflict, by document key, so a reload (which can
 * remount or fail) never loses what the owner wrote. Cleared on save or discard.
 */
const keptDrafts = new Map<string, string>()

/** Forget every kept draft (on sign-out, so nothing outlives the session). */
export function forgetDocumentDrafts() {
  keptDrafts.clear()
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
  canWrite,
  writeNote,
  onSave,
  onReload,
}: {
  document: VersionedDocument
  canWrite: boolean
  writeNote?: string | undefined
  onSave: (content: string, expectedVersion: string) => Promise<VersionedDocument>
  onReload: () => void
}) {
  const [stage, setStage] = useState<Stage>(() => {
    const kept = keptDrafts.get(document.key)
    return kept === undefined ? { kind: 'view' } : { kind: 'edit', draft: kept }
  })
  const restored = keptDrafts.has(document.key) && stage.kind !== 'view'
  const [error, setError] = useState<{ message: string; conflict: boolean }>()
  const [saving, setSaving] = useState(false)
  // The text a save replaced, offered back only while the document is still
  // the version that save produced (not another entry, nor a later change).
  const [backup, setBackup] = useState<{ content: string; version: string }>()

  if (stage.kind === 'view')
    return (
      <div className={styles.section}>
        <pre className={styles.doc}>{document.content}</pre>
        <p className={styles.note}>
          Read {new Date(document.readAt).toLocaleString()} from {document.source}.
          Version <code>{document.version.slice(0, 12)}</code>.
        </p>
        {backup?.version === document.version ? (
          <p className={styles.note}>
            The previous version is kept on this screen until you leave it.{' '}
            <Button
              variant="quiet"
              onClick={() => setStage({ kind: 'edit', draft: backup.content })}
            >
              Restore previous version
            </Button>
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="quiet" onClick={onReload}>
            Reload
          </Button>
          {canWrite ? (
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
        {restored ? (
          <p className={styles.note} role="status">
            Your unsaved draft was kept after the conflict. Review it against the current
            version before saving.
          </p>
        ) : null}
        <label className="visually-hidden" htmlFor="doc-editor">
          Edit {document.key}
        </label>
        <textarea
          id="doc-editor"
          className={styles.editor}
          value={stage.draft}
          spellCheck
          onChange={(event) => setStage({ kind: 'edit', draft: event.target.value })}
        />
        <div className={styles.actions}>
          <Button
            variant="quiet"
            onClick={() => {
              keptDrafts.delete(document.key)
              setStage({ kind: 'view' })
            }}
          >
            Discard changes
          </Button>
          <Button
            variant="primary"
            disabled={stage.draft === document.content}
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
      keptDrafts.delete(document.key)
      setBackup({ content: previous, version: saved.version })
      setStage({ kind: 'view' })
    } catch (err) {
      if (isCindlError(err) && err.code === 'conflict') {
        keptDrafts.set(document.key, draft)
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
      <Review before={document.content} draft={draft} />
      {moved ? (
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
          disabled={saving || moved || Boolean(error?.conflict)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Confirm and save'}
        </Button>
      </div>
    </div>
  )
}
