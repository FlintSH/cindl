import { clarifyDraftStore } from '../talk/requests.ts'

/**
 * Drafts kept after a save conflict, by document key, so a reload (which can
 * remount the editor or fail) never loses what the owner wrote. Cleared on
 * save or discard, and on sign-out (web parity).
 */
export const keptDrafts = new Map<string, string>()

/**
 * Forgets everything typed on this device that is kept in memory (document
 * drafts, which can hold memory or SOUL text, and unsent question answers):
 * after a sign-out, nothing typed outlives the session.
 */
export function forgetDrafts(): void {
  keptDrafts.clear()
  clarifyDraftStore.clear()
}
