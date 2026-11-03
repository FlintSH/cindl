import type { VersionedDocument } from '@cindl/contracts'

/**
 * The document editor's decisions (web parity:
 * apps/web/src/views/DocumentEditor.tsx), kept free of React Native so tests
 * can drive them. `base` is the version the owner reviewed the draft against.
 */
export type Stage =
  | { kind: 'view' }
  | { kind: 'edit'; draft: string }
  | { kind: 'review'; draft: string; base: string }

/** An editor opens on the draft kept for its document, if there is one. */
export function initialStage(kept: string | undefined): Stage {
  return kept === undefined ? { kind: 'view' } : { kind: 'edit', draft: kept }
}

/** Review records the version the draft is compared with; the save carries it. */
export function reviewStage(draft: string, document: VersionedDocument): Stage {
  return { kind: 'review', draft, base: document.version }
}

/**
 * What the owner reviewed is no longer what is shown (Hermes changed it, or
 * another document took its place): saving needs a fresh review.
 */
export function reviewMoved(base: string, document: VersionedDocument): boolean {
  return base !== document.version
}

/**
 * The draft kept under the editor's draft key. A locked editor keeps its draft
 * under the key it was written for, so closing it loses nothing and the draft
 * never returns to a different document. So does an editor asked to keep its
 * draft while it is edited (one written for another document).
 */
export function keptDraft(
  locked: string | undefined,
  keepDraft: boolean,
  stage: Stage,
): string | undefined {
  return (locked || keepDraft) && stage.kind !== 'view' ? stage.draft : undefined
}

export const RESTORED_DRAFT =
  'Your unsaved draft was kept. Review it against the current version before saving.'
export const ADOPTION_BUSY = 'Reading the entry now here…'
export const ADOPTION_NOT_USED = 'Your draft was not used, and it is still kept.'

/**
 * What a locked editor says and offers: why it is locked, an adoption that
 * failed or is under way, and "Use this draft for the entry now here" while
 * there is a draft (disabled while its read is out).
 */
export function lockPanel(input: {
  locked: string | undefined
  canAdopt: boolean
  stage: Stage
  adoption: { busy: boolean; error?: string | undefined } | undefined
}):
  | {
      alerts: string[]
      note: string | undefined
      busy: string | undefined
      adopt: { disabled: boolean } | undefined
    }
  | undefined {
  if (!input.locked) return undefined
  const error = input.adoption?.error
  return {
    alerts: error ? [input.locked, error] : [input.locked],
    note: error ? ADOPTION_NOT_USED : undefined,
    busy: input.adoption?.busy ? ADOPTION_BUSY : undefined,
    adopt:
      input.canAdopt && input.stage.kind !== 'view'
        ? { disabled: Boolean(input.adoption?.busy) }
        : undefined,
  }
}

/** What is said above a draft being edited: the caller's note, else that a kept draft came back. */
export function draftNotice(input: {
  draftNote: string | undefined
  restored: boolean
  locked: string | undefined
}): string | undefined {
  if (input.locked) return undefined
  if (input.draftNote) return input.draftNote
  return input.restored ? RESTORED_DRAFT : undefined
}

/**
 * The text a save replaced (Hermes keeps no backup). It can be restored only
 * onto the version that save produced; once the document shown is anything
 * else (a later change, another entry, a locked editor), it is only shown, to
 * copy, because restoring would write over something else.
 */
export function previousTextOffer(
  backup: { content: string; version: string } | undefined,
  document: VersionedDocument,
  locked: string | undefined,
): 'restore' | 'copy' | undefined {
  if (!backup) return undefined
  return !locked && backup.version === document.version ? 'restore' : 'copy'
}
