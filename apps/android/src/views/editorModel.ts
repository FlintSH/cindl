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
 * A locked editor keeps its draft under the key it was written for, so closing
 * it loses nothing and the draft never returns to a different document.
 */
export function lockedDraft(
  locked: string | undefined,
  stage: Stage,
): string | undefined {
  return locked && stage.kind !== 'view' ? stage.draft : undefined
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
