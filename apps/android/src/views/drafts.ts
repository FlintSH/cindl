import { clarifyDraftStore } from '../talk/requests.ts'

/**
 * Drafts kept after a save conflict or when an editor locks, by draft key, so
 * a reload (which can remount the editor or fail) never loses what the owner
 * wrote. A draft key names the document a draft was written for (for memory,
 * the entry's identity, never its place), so a kept draft only ever returns to
 * that document. Cleared on save or discard, and on sign-out (web parity).
 */
export const keptDrafts = new Map<string, string>()

/** Kept drafts whose key starts with `prefix`, oldest first. */
export function keptDocumentDrafts(
  prefix: string,
): Array<{ key: string; draft: string }> {
  return [...keptDrafts]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, draft]) => ({ key, draft }))
}

/** Forgets one kept draft. */
export function forgetDocumentDraft(key: string): void {
  keptDrafts.delete(key)
}

/**
 * Forgets everything typed on this device that is kept in memory (document
 * drafts, which can hold memory or SOUL text, and unsent question answers):
 * after a sign-out, nothing typed outlives the session.
 */
export function forgetDrafts(): void {
  keptDrafts.clear()
  clarifyDraftStore.clear()
}
