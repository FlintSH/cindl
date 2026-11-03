import type { CindlClientApi, OpResult } from '@cindl/contracts'
import { useSyncExternalStore } from 'react'
import { forgetPlaces } from '../talk/places.ts'
import { pruneRequestDrafts } from '../talk/RequestCard.tsx'
import { forgetDocumentDrafts } from '../views/DocumentEditor.tsx'

// What this page's own sign-in and sign-out attempts leave behind, in memory
// for this page only, like everything else the web keeps:
// - whether Hermes did not confirm its last sign-out (the web only: native
//   clients have nothing to confirm). The sign-in screen then offers to sign
//   out on Hermes again, until Hermes confirms it or the page is online again.
// - the sign-in the sign-in screen started, while it is out: "Check again" on
//   the web, or the desktop's wait for the system browser. The client says it
//   is connecting meanwhile, and the sign-in screen stays until that attempt
//   settles. "Stop waiting" frees the form, not the screen: the attempt is
//   still out until the client ends it or a new one replaces it.
let state = { unconfirmed: false, signingIn: 0 }
let attempts = 0
const listeners = new Set<() => void>()

function update(next: Partial<typeof state>) {
  const merged = { ...state, ...next }
  if (merged.unconfirmed === state.unconfirmed && merged.signingIn === state.signingIn)
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
  // Nothing typed or read on this device outlives the session.
  pruneRequestDrafts(new Set())
  forgetDocumentDrafts()
  forgetPlaces()
  update({ unconfirmed: result.hermesConfirmed === false })
  return result
}

/** Sign in from the sign-in screen, which stays while this attempt is the one out. */
export async function signInHere(
  api: CindlClientApi,
  origin: string,
): Promise<OpResult<'auth.signIn'>> {
  const attempt = ++attempts
  update({ signingIn: attempt })
  try {
    return await api.call('auth.signIn', { origin })
  } finally {
    // An attempt a newer one replaced leaves the newer one's hold alone.
    if (state.signingIn === attempt) update({ signingIn: 0 })
  }
}

/** Online again: an earlier sign-out's outcome no longer applies. */
export function forgetSignOut(): void {
  update({ unconfirmed: false })
}

export function useSignOutUnconfirmed(): boolean {
  return useSyncExternalStore(subscribe, () => state.unconfirmed)
}

export function useSigningIn(): boolean {
  return useSyncExternalStore(subscribe, () => state.signingIn !== 0)
}
