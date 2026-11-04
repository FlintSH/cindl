import { useCallback, useRef, type Ref } from 'react'
import {
  Pressable,
  type GestureResponderEvent,
  type HostInstance,
  type PressableProps,
} from 'react-native'
import { notePress } from '../overlay/opener.ts'

/**
 * The app's Pressable. It notes each press (overlay/opener.ts), so a dialog or
 * sheet it opens gives focus back to it, and a step that lands later (a save)
 * gives none once the owner pressed something else. Every control is built on
 * it (Button and Row are; lint: cindl-android/no-bare-pressable), or notes its
 * press itself, as a link in agent Markdown does. Everything else it is given
 * goes to the Pressable as it is: `disabled` stops a second press,
 * `accessibilityState` is what TalkBack reads.
 */
export function Press({
  ref,
  onPress,
  ...props
}: PressableProps & { ref?: Ref<HostInstance> }) {
  // Its own handle on the view, besides the caller's: the press notes this one.
  const self = useRef<HostInstance | null>(null)
  const attach = useCallback(
    (node: HostInstance | null) => {
      self.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )
  return (
    <Pressable
      ref={attach}
      {...props}
      {...(onPress
        ? {
            onPress: (event: GestureResponderEvent) => {
              notePress(self)
              onPress(event)
            },
          }
        : {})}
    />
  )
}
