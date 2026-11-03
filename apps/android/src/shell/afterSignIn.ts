import type { LinkState } from '@cindl/contracts'

export const CONNECTING_AFTER_SIGN_IN = 'Signed in. Connecting to Hermes…'
export const REFUSED_AFTER_SIGN_IN =
  'Hermes did not accept this sign-in after all. Nothing was saved. Try again.'

/**
 * What the sign-in screen says once the browser leg finished but the link is
 * not online yet. Without it, a connection that never came up left the empty
 * form with no message and no way to the rest of the app, where Agent can
 * sign out (review of 636a2dd, N12). `canContinue`: the owner may leave the
 * sign-in screen; the app then shows the link's state, and the client keeps
 * trying.
 */
export function afterSignIn(
  signedIn: boolean,
  link: Pick<LinkState, 'phase' | 'lastError'>,
):
  | { kind: 'none' }
  | { kind: 'connecting'; message: string }
  | { kind: 'stuck'; message: string; canContinue: boolean } {
  if (!signedIn || link.phase === 'online') return { kind: 'none' }
  const reason = link.lastError?.message
  if ((link.phase === 'connecting' || link.phase === 'reconnecting') && !reason)
    return { kind: 'connecting', message: CONNECTING_AFTER_SIGN_IN }
  if (link.phase === 'signed-out' || link.phase === 'unconfigured')
    return { kind: 'stuck', message: reason ?? REFUSED_AFTER_SIGN_IN, canContinue: false }
  return {
    kind: 'stuck',
    message: `Signed in, but Cindl could not connect to Hermes${reason ? `: ${reason}` : '.'}`,
    canContinue: true,
  }
}
