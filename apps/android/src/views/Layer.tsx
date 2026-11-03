import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

/**
 * A full-size layer that stays mounted while hidden, so its scroll position
 * is exactly where the owner left it on return. Hidden layers ignore touches
 * and are removed from TalkBack's view.
 */
export function Layer({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <View
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
