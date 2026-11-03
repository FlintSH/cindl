import { diffLines, diffStats } from '@cindl/client-core'
import { isCindlError, type VersionedDocument } from '@cindl/contracts'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type Ref,
} from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './views.module.css'

/**
 * `base` is the version the owner reviewed the draft against. `keptAs` is the
 * kept-draft key this draft came from or was filed under; a save or discard
 * forgets that key only, never another kept draft.
 */
type Stage =
  | { kind: 'view' }
  | { kind: 'edit'; draft: string; keptAs?: string | undefined }
  | { kind: 'review'; draft: string; base: string; keptAs?: string | undefined }

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

/**
 * Where to keep a draft: the key it already has, else the document's key,
 * unless that holds a different draft, which is never replaced. Then the draft
 * is filed beside it (`<key>#2`, `#3`…), and lists of kept drafts show it.
 */
function keepKey(draftKey: string, keptAs: string | undefined, draft: string) {
  if (keptAs !== undefined) return keptAs
  const existing = keptDrafts.get(draftKey)
  if (existing === undefined || existing === draft) return draftKey
  let n = 2
  while (keptDrafts.has(`${draftKey}#${n}`)) n += 1
  return `${draftKey}#${n}`
}

function Review({
  before,
  draft,
  changes,
}: {
  before: string
  draft: string
  changes: Ref<HTMLPreElement>
}) {
  const { lines, exact } = useMemo(() => diffLines(before, draft), [before, draft])
  const stats = diffStats(lines)
  return (
    <>
      <p>
        Review before saving: <strong>{stats.added}</strong> line
        {stats.added === 1 ? '' : 's'} added, <strong>{stats.removed}</strong> removed.
        {exact ? '' : ' (Large document: shown as a full replacement.)'}
      </p>
      <pre className={styles.diff} aria-label="Changes" ref={changes} tabIndex={-1}>
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
  nowHere,
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
   * may not be it). The draft stays visible, read-only, and is kept. Given as
   * a function, it is told where the draft in the box is kept, so it can say
   * where that draft goes when the editor closes.
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
  /** Said above a draft in place of the kept-after-a-conflict note. */
  draftNote?: string | undefined
  /** Keep the draft under `draftKey` while it is edited, not only once locked. */
  keepDraft?: boolean
  /** The owner discarded the draft (its kept copy, if any, is forgotten first). */
  onDiscard?: (() => void) | undefined
  onSave: (content: string, expectedVersion: string) => Promise<VersionedDocument>
  onReload: () => void
}) {
  const [stage, setStage] = useState<Stage>(() => {
    const kept = keptDrafts.get(draftKey)
    return kept === undefined
      ? { kind: 'view' }
      : { kind: 'edit', draft: kept, keptAs: draftKey }
  })
  const [, setKeptSeen] = useState(0)
  const keptAs = stage.kind === 'view' ? undefined : stage.keptAs
  // Where the box's draft is kept now. A save or conflict that ends after the
  // editor locked (the lock files the draft) must act on that key, not on the
  // one the draft had when the save started.
  const keptAsNow = useRef(keptAs)
  useLayoutEffect(() => {
    keptAsNow.current = keptAs
  })
  const lockText = typeof locked === 'function' ? locked(keptAs) : locked
  // The box holds this document's kept draft.
  const restored = keptAs === draftKey && keptDrafts.has(draftKey)
  // A kept draft for this document that the box is not showing: offered, never
  // replaced or forgotten by what happens in the box.
  const otherKept = keptAs === draftKey ? undefined : keptDrafts.get(draftKey)
  // A locked editor keeps its draft under the key it was written for, so
  // closing it loses nothing (the owner can copy it from the list of kept
  // drafts) and it never returns to a different document. So does an editor
  // asked to keep its draft (one written for another document).
  const keptDraft =
    (lockText || keepDraft) && stage.kind !== 'view' ? stage.draft : undefined
  useEffect(() => {
    if (keptDraft === undefined) return
    const key = keepKey(draftKey, keptAs, keptDraft)
    keptDrafts.set(key, keptDraft)
    if (key !== keptAs)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- records where the draft was filed, once
      setStage((now) => (now.kind === 'view' ? now : { ...now, keptAs: key }))
  }, [draftKey, keptAs, keptDraft])
  // Each step is keyed by its kind, so a step's controls are replaced, never
  // reused as another step's (a focused Edit would become Review changes).
  // Focus never drops to the page because of a change here. When the control
  // that had focus goes (a lock or an adoption, Continue, a discard, a step to
  // review or back), focus moves to what took its place: the lock notice while
  // locked, else the draft, the changes under review, or Edit (Reload when
  // there is no Edit). A lock that lands or lifts with nothing focused moves
  // focus the same way. Focus the owner moved elsewhere stays there.
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const notice = useRef<HTMLDivElement>(null)
  const changes = useRef<HTMLPreElement>(null)
  const edit = useRef<HTMLButtonElement>(null)
  const reload = useRef<HTMLButtonElement>(null)
  const focused = useRef<Element | null>(null)
  const wasLocked = useRef(Boolean(lockText))
  useLayoutEffect(() => {
    const lockedNow = Boolean(lockText)
    const lockMoved = wasLocked.current !== lockedNow
    wasLocked.current = lockedNow
    const page = root.current?.ownerDocument
    if (!page) return
    const active = page.activeElement
    if (active && active !== page.body) {
      focused.current = root.current?.contains(active) ? active : null
      return
    }
    const was = focused.current
    focused.current = null
    const taken = was !== null && (!was.isConnected || was.matches(':disabled'))
    if (!taken && !lockMoved) return
    const target = lockedNow
      ? notice.current
      : (box.current ?? changes.current ?? edit.current ?? reload.current)
    target?.focus()
  })
  const track = (event: FocusEvent) => {
    focused.current = event.target
  }
  const hereId = useId()
  const [error, setError] = useState<{ message: string; conflict: boolean }>()
  const [saving, setSaving] = useState(false)
  // The text a save replaced, offered back only while the document is still
  // the version that save produced (not another entry, nor a later change).
  const [backup, setBackup] = useState<{ content: string; version: string }>()
  const lockNotice = lockText ? (
    <div className={styles.section} ref={notice} tabIndex={-1}>
      <p className={styles.error} role="alert">
        {lockText}
      </p>
      {nowHere ? (
        <p className={styles.note} id={hereId}>
          Now at this place: “{nowHere}”.
        </p>
      ) : null}
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
      {stage.kind !== 'view' ? (
        <div className={styles.actions}>
          {/* The view stage has its own Reload; here the list may be stale. */}
          <Button variant="quiet" onClick={onReload}>
            Reload
          </Button>
          {onAdopt ? (
            <Button
              variant="quiet"
              disabled={Boolean(adoption?.busy)}
              aria-describedby={nowHere ? hereId : undefined}
              onClick={() => onAdopt(keptAs)}
            >
              Use this draft for the entry now here
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null

  if (stage.kind === 'view')
    return (
      <div key="view" className={styles.section} ref={root} onFocus={track}>
        {lockNotice}
        <pre className={styles.doc}>{document.content}</pre>
        <p className={styles.note}>
          Read {new Date(document.readAt).toLocaleString()} from {document.source}.
          Version <code>{document.version.slice(0, 12)}</code>.
        </p>
        {otherKept !== undefined && !lockText ? (
          <div className={styles.section}>
            <p className={styles.note} role="status">
              An unsaved draft for this is kept on this device:
            </p>
            <pre className={styles.doc}>{otherKept}</pre>
            <div className={styles.actions}>
              <Button
                variant="quiet"
                onClick={() => {
                  keptDrafts.delete(draftKey)
                  setKeptSeen((value) => value + 1)
                }}
              >
                Discard the draft
              </Button>
              {canWrite ? (
                <Button
                  onClick={() =>
                    setStage({ kind: 'edit', draft: otherKept, keptAs: draftKey })
                  }
                >
                  Continue the draft
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {backup && !lockText && backup.version === document.version ? (
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
          <Button variant="quiet" ref={reload} onClick={onReload}>
            Reload
          </Button>
          {canWrite && !lockText ? (
            <Button
              ref={edit}
              onClick={() => setStage({ kind: 'edit', draft: document.content })}
            >
              Edit
            </Button>
          ) : null}
        </div>
        {writeNote ? <p className={styles.note}>{writeNote}</p> : null}
      </div>
    )

  if (stage.kind === 'edit')
    return (
      <div key="edit" className={styles.section} ref={root} onFocus={track}>
        {lockNotice}
        {draftNote && !lockText ? (
          <p className={styles.note} role="status">
            {draftNote}
          </p>
        ) : restored && !lockText ? (
          <p className={styles.note} role="status">
            Your unsaved draft was kept. Review it against the current version before
            saving.
          </p>
        ) : null}
        {otherKept !== undefined && !lockText ? (
          <p className={styles.note}>
            Another unsaved draft for this is kept on this device. Saving or discarding
            this one leaves it.
          </p>
        ) : null}
        <label className="visually-hidden" htmlFor="doc-editor">
          Edit {document.key}
        </label>
        <textarea
          id="doc-editor"
          ref={box}
          className={styles.editor}
          value={stage.draft}
          readOnly={Boolean(lockText)}
          spellCheck
          onChange={(event) =>
            setStage({ kind: 'edit', draft: event.target.value, keptAs: stage.keptAs })
          }
        />
        <div className={styles.actions}>
          <Button
            variant="quiet"
            onClick={() => {
              if (stage.keptAs !== undefined) keptDrafts.delete(stage.keptAs)
              setStage({ kind: 'view' })
              onDiscard?.()
            }}
          >
            Discard changes
          </Button>
          <Button
            variant="primary"
            disabled={Boolean(lockText) || stage.draft === document.content}
            onClick={() =>
              setStage({
                kind: 'review',
                draft: stage.draft,
                base: document.version,
                keptAs: stage.keptAs,
              })
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
      // The draft is saved: forget its kept copy, wherever it is filed now.
      if (keptAsNow.current !== undefined) keptDrafts.delete(keptAsNow.current)
      setBackup({ content: previous, version: saved.version })
      setStage({ kind: 'view' })
    } catch (err) {
      if (isCindlError(err) && err.code === 'conflict') {
        const key = keepKey(draftKey, keptAsNow.current, draft)
        keptDrafts.set(key, draft)
        setStage({ kind: 'review', draft, base, keptAs: key })
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
    <div key="review" className={styles.section} ref={root} onFocus={track}>
      {lockNotice}
      <Review before={document.content} draft={draft} changes={changes} />
      {moved && !lockText ? (
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
              setStage({ kind: 'edit', draft, keptAs: stage.keptAs })
            }}
          >
            Reload and keep my draft
          </Button>
        ) : null}
        <Button
          variant="quiet"
          disabled={saving}
          onClick={() => setStage({ kind: 'edit', draft, keptAs: stage.keptAs })}
        >
          Back to editing
        </Button>
        <Button
          variant="primary"
          disabled={saving || moved || Boolean(lockText) || Boolean(error?.conflict)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Confirm and save'}
        </Button>
      </div>
    </div>
  )
}
