import { createContext, useContext } from 'react'
import type { HostInstance } from 'react-native'

/** A control TalkBack focus can be sent to, read when it is needed. */
export type FocusTarget = () => HostInstance | null | undefined

/**
 * The control the owner pressed last, for a moment, so a dialog or sheet it
 * opens can give TalkBack focus back to it when it closes. React Native does
 * not tell the app where TalkBack focus is; a control the owner just
 * activated is where it was. A press older than a second opened nothing that
 * opens now. System back presses nothing, so an overlay it opens has no
 * opener, unless a control was pressed in that second.
 */
let last: { control: { current: HostInstance | null }; at: number } | undefined

export function notePress(control: { current: HostInstance | null }): void {
  last = { control, at: Date.now() }
}

/** The control pressed just now, if any: the opener of an overlay opening now. */
export function justPressed(): { current: HostInstance | null } | undefined {
  return last && Date.now() - last.at < 1000 ? last.control : undefined
}

let claimed: number | undefined

/**
 * A closing action that moves focus itself (the working margin's Show, which
 * focuses the request it shows) claims it: the overlay closing now gives none
 * back. The claim is taken once, and lapses after a second.
 */
export function claimFocus(): void {
  claimed = Date.now()
}

/** No press noted and no claim: where tests start (the module keeps both across renders). */
export function forgetPresses(): void {
  last = undefined
  claimed = undefined
}

export function takeFocusClaim(): boolean {
  const fresh = claimed !== undefined && Date.now() - claimed < 1000
  claimed = undefined
  return fresh
}

const FallbackContext = createContext<FocusTarget | undefined>(undefined)

/**
 * Where focus goes when an overlay closes and the control that opened it is
 * gone: a sensible control on the screen behind (a page's heading, the
 * conversation switcher). An overlay can name a nearer one (`returnFocus`).
 */
export const FocusFallback = FallbackContext.Provider
export const useFocusFallback = () => useContext(FallbackContext)
