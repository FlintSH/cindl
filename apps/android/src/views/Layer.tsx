import { useEffect, useRef, type ReactNode } from 'react'
import { StyleSheet, View, type HostInstance } from 'react-native'
import { blockKeyboardFocus } from '../overlay/keyboardFocus.ts'

/**
 * A full-size layer that stays mounted while hidden, so its scroll position
 * is exactly where the owner left it on return. Hidden layers ignore touches,
 * are removed from TalkBack's view and are closed to a hardware keyboard's
 * focus, so Tab never reaches a control no one can see (modules/cindl-focus).
 */
export function Layer({ visible, children }: { visible: boolean; children: ReactNode }) {
  const self = useRef<HostInstance | null>(null)
  const blocked = useRef(false)
  useEffect(() => {
    if (blocked.current === !visible) return
    blocked.current = !visible
    blockKeyboardFocus(self.current, !visible)
  }, [visible])
  return (
    <View
      ref={self}
      collapsable={false}
      pointerEvents={visible ? 'auto' : 'none'}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!visible}
      style={[
        StyleSheet.absoluteFill,
        { opacity: visible ? 1 : 0, zIndex: visible ? 1 : 0 },
      ]}
    >
      {children}
    </View>
  )
}
