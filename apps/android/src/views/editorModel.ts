import type { VersionedDocument } from '@cindl/contracts'

/**
 * The document editor's decisions (web parity:
 * apps/web/src/views/DocumentEditor.tsx), kept free of React Native so tests
 * can drive them. `base` is the version the owner reviewed the draft against.
 * `keptAs` is the kept-draft key this draft came from or was filed under; a
 * save or discard forgets that key only, never another kept draft.
 */
export type Stage =
  | { kind: 'view' }
  | { kind: 'edit'; draft: string; keptAs?: string | undefined }
  | { kind: 'review'; draft: string; base: string; keptAs?: string | undefined }

/** An editor opens on the draft kept for its document (under `draftKey`), if there is one. */
export function initialStage(kept: string | undefined, draftKey: string): Stage {
  return kept === undefined
    ? { kind: 'view' }
    : { kind: 'edit', draft: kept, keptAs: draftKey }
}

/** Review records the version the draft is compared with; the save carries it. */
export function reviewStage(
  draft: string,
  document: VersionedDocument,
  keptAs: string | undefined,
): Stage {
  return { kind: 'review', draft, base: document.version, keptAs }
}

/**
 * What the owner reviewed is no longer what is shown (Hermes changed it, or
 * another document took its place): saving needs a fresh review.
 */
export function reviewMoved(base: string, document: VersionedDocument): boolean {
  return base !== document.version
}

/**
 * The draft to keep for the editor. A locked editor keeps its draft, so
 * closing it loses nothing and the draft never returns to a different
 * document. So does an editor asked to keep its draft while it is edited (one
 * written for another document).
 */
export function keptDraft(
  locked: string | undefined,
  keepDraft: boolean,
  stage: Stage,
): string | undefined {
  return (locked || keepDraft) && stage.kind !== 'view' ? stage.draft : undefined
}

/**
 * Where to keep a draft: the key it already has, else the document's key,
 * unless that holds a different draft, which is never replaced. Then the draft
 * is filed beside it (`<key>#2`, `#3`…), where lists of kept drafts show it.
 */
export function keepKey(
  kept: ReadonlyMap<string, string>,
  draftKey: string,
  keptAs: string | undefined,
  draft: string,
): string {
  if (keptAs !== undefined) return keptAs
  const existing = kept.get(draftKey)
  if (existing === undefined || existing === draft) return draftKey
  let n = 2
  while (kept.has(`${draftKey}#${n}`)) n += 1
  return `${draftKey}#${n}`
}

/**
 * The document's kept draft and the box: `restored` when the box holds it;
 * `offered` when it is kept but the box is not showing it (it is offered, and
 * nothing done in the box replaces or forgets it).
 */
export function keptState(
  kept: ReadonlyMap<string, string>,
  draftKey: string,
  stage: Stage,
): { restored: boolean; offered: string | undefined } {
  const keptAs = stage.kind === 'view' ? undefined : stage.keptAs
  return {
    restored: keptAs === draftKey && kept.has(draftKey),
    offered: keptAs === draftKey ? undefined : kept.get(draftKey),
  }
}

export const RESTORED_DRAFT =
  'Your unsaved draft was kept. Review it against the current version before saving.'
export const KEPT_OFFER = 'An unsaved draft for this is kept on this device:'
export const KEPT_BESIDE =
  'Another unsaved draft for this is kept on this device. Saving or discarding this one leaves it.'
export const ADOPTION_BUSY = 'Reading the entry now here…'
export const ADOPTION_NOT_USED = 'Your draft was not used, and it is still kept.'

/** Names the document an adoption would use the draft for. */
export const nowHereNote = (title: string) => `Now at this place: “${title}”.`

/**
 * What a locked editor says and offers: why it is locked, which document is
 * shown now, an adoption that failed or is under way, and while there is a
 * draft, Reload (the list may be stale) and "Use this draft for the entry now
 * here" (disabled while its read is out, described by the document now shown).
 */
export function lockPanel(input: {
  locked: string | undefined
  canAdopt: boolean
  stage: Stage
  adoption: { busy: boolean; error?: string | undefined } | undefined
  nowHere: string | undefined
}):
  | {
      alerts: string[]
      note: string | undefined
      nowHere: string | undefined
      busy: string | undefined
      reload: boolean
      adopt: { disabled: boolean; hint: string | undefined } | undefined
    }
  | undefined {
  if (!input.locked) return undefined
  const error = input.adoption?.error
  const drafting = input.stage.kind !== 'view'
  const nowHere = input.nowHere === undefined ? undefined : nowHereNote(input.nowHere)
  return {
    alerts: error ? [input.locked, error] : [input.locked],
    note: error ? ADOPTION_NOT_USED : undefined,
    nowHere,
    busy: input.adoption?.busy ? ADOPTION_BUSY : undefined,
    // The view stage has its own Reload.
    reload: drafting,
    adopt:
      input.canAdopt && drafting
        ? { disabled: Boolean(input.adoption?.busy), hint: nowHere }
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
 * Where TalkBack focus goes when the lock changes: into the draft when a lock
 * lifts (an adoption completed), onto the lock notice when one starts (it
 * takes Edit and Delete away; React Native does not say which control
 * TalkBack was on, so the notice gets focus whenever the editor locks).
 */
export function focusAfterLock(
  wasLocked: boolean,
  lockedNow: boolean,
): 'draft' | 'notice' | undefined {
  if (wasLocked && !lockedNow) return 'draft'
  if (!wasLocked && lockedNow) return 'notice'
  return undefined
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
