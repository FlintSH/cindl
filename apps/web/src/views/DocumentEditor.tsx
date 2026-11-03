import { diffLines, diffStats } from '@cindl/client-core'
import { isCindlError, type VersionedDocument } from '@cindl/contracts'
import { useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './views.module.css'

type Stage =
  { kind: 'view' } | { kind: 'edit'; draft: string } | { kind: 'review'; draft: string }

/**
 * Owner edits go through three explicit steps: edit, review the exact diff
 * against the version that was read, confirm. The write carries that version,
 * so a document changed elsewhere in the meantime is rejected, not clobbered.
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
  const [stage, setStage] = useState<Stage>({ kind: 'view' })
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [backup, setBackup] = useState<string>()

  if (stage.kind === 'view')
    return (
      <div className={styles.section}>
        <pre className={styles.doc}>{document.content}</pre>
        <p className={styles.note}>
          Read {new Date(document.readAt).toLocaleString()} from {document.source}.
          Version <code>{document.version.slice(0, 12)}</code>.
        </p>
        {backup !== undefined ? (
          <p className={styles.note}>
            The previous version is kept on this screen until you leave it.{' '}
            <Button
              variant="quiet"
              onClick={() => setStage({ kind: 'edit', draft: backup })}
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
          <Button variant="quiet" onClick={() => setStage({ kind: 'view' })}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={stage.draft === document.content}
            onClick={() => setStage({ kind: 'review', draft: stage.draft })}
          >
            Review changes
          </Button>
        </div>
      </div>
    )

  const { lines, exact } = diffLines(document.content, stage.draft)
  const stats = diffStats(lines)
  const draft = stage.draft
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const previous = document.content
      await onSave(draft, document.version)
      setBackup(previous)
      setStage({ kind: 'view' })
    } catch (err) {
      setError(
        isCindlError(err) && err.code === 'conflict'
          ? `${err.message} Your draft is kept; reload to see the current version.`
          : isCindlError(err)
            ? err.message
            : 'Saving failed. Nothing was changed.',
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className={styles.section}>
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
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="quiet"
          disabled={saving}
          onClick={() => setStage({ kind: 'edit', draft })}
        >
          Back to editing
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Confirm and save'}
        </Button>
      </div>
    </div>
  )
}
