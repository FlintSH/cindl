import type { CindlClientApi, OpResult } from '@cindl/contracts'
import { useSyncExternalStore } from 'react'
import { pruneRequestDrafts } from '../talk/RequestCard.tsx'
import { forgetDocumentDrafts } from '../views/DocumentEditor.tsx'

// Whether Hermes did not confirm this page's last sign-out (the web only:
// native clients have nothing to confirm). The sign-in screen then offers to
// sign out on Hermes again, until Hermes confirms it or the page is online
// again. In memory for this page only, like everything else the web keeps.
let unconfirmed = false
const listeners = new Set<() => void>()

function setUnconfirmed(value: boolean) {
  if (value === unconfirmed) return
  unconfirmed = value
  for (const listener of listeners) listener()
}

/** Sign out on this device, from the device page or again from the sign-in screen. */
export async function signOutHere(
  api: CindlClientApi,
): Promise<OpResult<'auth.signOut'>> {
  const result = await api.call('auth.signOut', {})
  // Nothing typed on this device outlives the session.
  pruneRequestDrafts(new Set())
  forgetDocumentDrafts()
  setUnconfirmed(result.hermesConfirmed === false)
  return result
}

/** Online again: an earlier sign-out's outcome no longer applies. */
export function forgetSignOut(): void {
  setUnconfirmed(false)
}

export function useSignOutUnconfirmed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => unconfirmed,
  )
}
