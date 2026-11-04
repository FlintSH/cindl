import type { LinkState } from '@cindl/contracts'
import { useEffect } from 'react'
import { forgetPlaces } from '../talk/places.ts'
import { forgetDrafts, sessionEnded } from '../views/drafts.ts'

/**
 * Nothing typed on this device outlives the session, however it ended: the
 * sign-out button, or Hermes refusing the session (web parity). Kept drafts go
 * too, so none comes back after another sign-in, to this Hermes or another,
 * and so does where the owner left each conversation (talk/places.ts).
 * AppShell runs this for the whole app.
 */
export function useSessionDrafts(link: Pick<LinkState, 'phase' | 'demo'>) {
  const ended = sessionEnded(link)
  useEffect(() => {
    if (!ended) return
    forgetDrafts()
    forgetPlaces()
  }, [ended])
}
