import { Animated, Pressable, StyleSheet } from 'react-native'
import { useTheme } from '../theme/theme.tsx'
import { SCRIM_ID } from './scrim.ts'

/**
 * What a dialog or sheet lays over the screen: a tap on it closes the overlay.
 * It is no control, so it notes no press (lint: cindl-android/no-bare-pressable
 * spares this file): the overlay it closes opened after a press, which counted.
 */
export function Scrim({
  progress,
  onPress,
}: {
  progress: Animated.Value
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.colors.scrim, opacity: progress },
      ]}
    >
      {/* A touch target only. Pressable passes `focusable` (true unless false)
          after `accessible`, and React Native 0.88 applies both to the view's
          focusability, so without focusable={false} the scrim would be a stop
          for a keyboard's focus (CI run 41712256173: Tab went to it first). */}
      <Pressable
        testID={SCRIM_ID}
        style={StyleSheet.absoluteFill}
        onPress={onPress}
        accessible={false}
        focusable={false}
        importantForAccessibility="no"
      />
    </Animated.View>
  )
}
