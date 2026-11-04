import type { CindlClientApi, OpResult } from '@cindl/contracts'
import { useSyncExternalStore } from 'react'
import { pruneRequestDrafts } from '../talk/RequestCard.tsx'
import { forgetDocumentDrafts } from '../views/DocumentEditor.tsx'

// What this page's own sign-in and sign-out attempts leave behind, in memory
// for this page only, like everything else the web keeps:
// - whether Hermes did not confirm its last sign-out (the web only: native
//   clients have nothing to confirm). The sign-in screen then offers to sign
//   out on Hermes again, until Hermes confirms it or the page is online again.
// - whether a "Check again" is out. The client says it is connecting
//   meanwhile, and the sign-in screen stays until the check settles.
let state = { unconfirmed: false, checking: false }
const listeners = new Set<() => void>()

function update(next: Partial<typeof state>) {
  const merged = { ...state, ...next }
  if (merged.unconfirmed === state.unconfirmed && merged.checking === state.checking)
    return
  state = merged
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Sign out on this device, from the device page or again from the sign-in screen. */
export async function signOutHere(
  api: CindlClientApi,
): Promise<OpResult<'auth.signOut'>> {
  const result = await api.call('auth.signOut', {})
  // Nothing typed on this device outlives the session.
  pruneRequestDrafts(new Set())
  forgetDocumentDrafts()
  update({ unconfirmed: result.hermesConfirmed === false })
  return result
}

/** "Check again": whether this browser's Hermes session signs Cindl in now. */
export async function checkSignIn(
  api: CindlClientApi,
  origin: string,
): Promise<OpResult<'auth.signIn'>> {
  update({ checking: true })
  try {
    return await api.call('auth.signIn', { origin })
  } finally {
    update({ checking: false })
  }
}

/** Online again: an earlier sign-out's outcome no longer applies. */
export function forgetSignOut(): void {
  update({ unconfirmed: false })
}

export function useSignOutUnconfirmed(): boolean {
  return useSyncExternalStore(subscribe, () => state.unconfirmed)
}

export function useCheckingSignIn(): boolean {
  return useSyncExternalStore(subscribe, () => state.checking)
}
