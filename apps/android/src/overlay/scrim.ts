/**
 * The testID of every dialog's and sheet's scrim (Sheet.tsx). React Native
 * reports a testID as the node's resource-id, so a UI dump can tell the scrim
 * apart (e2e/ui.ts scrimOf): the scrim is neither clickable nor focusable
 * there, since a keyboard's focus must never rest on it.
 */
export const SCRIM_ID = 'cindl-scrim'
