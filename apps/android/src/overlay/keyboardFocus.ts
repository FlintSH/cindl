import { findNodeHandle, type HostInstance } from 'react-native'
import { focusNative } from '../../modules/cindl-focus/index.ts'

const tagOf = (node: HostInstance | null | undefined) =>
  node ? findNodeHandle(node) : null

/**
 * Hardware keyboard focus while overlays are open (modules/cindl-focus): what
 * an overlay covers takes none, so Tab, Shift+Tab and the arrow keys stay in
 * the overlay. Neither call does anything where the module is not linked, or
 * when its view went before the call reached it.
 */
export function blockKeyboardFocus(
  node: HostInstance | null | undefined,
  blocked: boolean,
): void {
  const tag = tagOf(node)
  if (tag != null)
    focusNative?.block(tag, blocked).catch(() => {
      // The view is gone: nothing is left to block.
    })
}

/**
 * Gives a keyboard's focus to `node`, or to the first control of its nearest
 * ancestor that has one: into an overlay as it opens, back to what opened it
 * as it closes. Nothing in touch mode (the Kotlin side checks).
 */
export function giveKeyboardFocus(node: HostInstance | null | undefined): void {
  const tag = tagOf(node)
  if (tag != null)
    focusNative?.focus(tag).catch(() => {
      // The view is gone: focus stays where it is.
    })
}
