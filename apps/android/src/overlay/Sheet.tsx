import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type HostInstance,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useBackHandler } from '../nav/NavProvider.tsx'
import { useKeyboardHeight } from '../shell/keyboard.tsx'
import { useReducedMotion } from '../theme/motion.tsx'
import { useTheme } from '../theme/theme.tsx'
import { X } from '../ui/icons.ts'
import { Button } from '../ui/primitives.tsx'
import { Portal } from './Portal.tsx'

/** Moves TalkBack focus to an overlay's title once it is on screen. */
function useInitialFocus(ref: { current: HostInstance | null }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      if (ref.current) AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus')
    }, 60)
    return () => clearTimeout(timer)
  }, [ref])
}

/** Fades (and for sheets, lifts) an overlay in; instant under reduced motion. */
function useEntrance(): Animated.Value {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0))
  useEffect(() => {
    if (reduced) {
      progress.setValue(1)
      return
    }
    const [x1, y1, x2, y2] = theme.motion.easing.enter
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: theme.motion.duration.slow,
      easing: Easing.bezier(x1, y1, x2, y2),
      useNativeDriver: true,
    })
    animation.start()
    return () => animation.stop()
  }, [progress, reduced, theme])
  return progress
}

function Scrim({ progress, onPress }: { progress: Animated.Value; onPress: () => void }) {
  const theme = useTheme()
  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.colors.scrim, opacity: progress },
      ]}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onPress}
        accessible={false}
        importantForAccessibility="no"
      />
    </Animated.View>
  )
}

/**
 * Bottom sheet for the working margin, conversation history and similar
 * overlays. System back and a tap on the scrim close it; it stays above the
 * keyboard and the navigation bar.
 */
export function Sheet({
  open,
  onClose,
  title,
  closeLabel = 'Close',
  headerAside,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  headerAside?: ReactNode
  children: ReactNode
}) {
  useBackHandler(() => {
    onClose()
    return true
  }, open)
  if (!open) return null
  return (
    <Portal>
      <SheetFrame
        title={title}
        closeLabel={closeLabel}
        onClose={onClose}
        headerAside={headerAside}
      >
        {children}
      </SheetFrame>
    </Portal>
  )
}

function SheetFrame({
  title,
  closeLabel,
  onClose,
  headerAside,
  children,
}: {
  title: string
  closeLabel: string
  onClose: () => void
  headerAside: ReactNode
  children: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const { height } = useWindowDimensions()
  const progress = useEntrance()
  const titleRef = useRef<HostInstance>(null)
  useInitialFocus(titleRef)
  const bottom = keyboard > 0 ? Math.max(keyboard, insets.bottom) : insets.bottom
  return (
    <View style={StyleSheet.absoluteFill}>
      <Scrim progress={progress} onPress={onClose} />
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: height - insets.top - theme.space[6],
          paddingBottom: bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radius.lg,
          borderTopRightRadius: theme.radius.lg,
          borderTopWidth: 1,
          borderColor: theme.colors.border,
          boxShadow: theme.shadow.overlay,
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [24, 0],
              }),
            },
          ],
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space[1],
            minHeight: 56,
            paddingLeft: theme.space[4],
            paddingRight: theme.space[2],
            borderBottomWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Text
            ref={titleRef}
            accessibilityRole="header"
            style={[
              theme.text.ui,
              { flex: 1, fontFamily: theme.fonts.semibold, color: theme.colors.text },
            ]}
          >
            {title}
          </Text>
          {headerAside}
          <Button
            label={closeLabel}
            icon={X}
            iconOnly
            variant="quiet"
            onPress={onClose}
          />
        </View>
        {children}
      </Animated.View>
    </View>
  )
}

/**
 * Centered confirmation dialog. Owner decisions that change the Hermes host
 * (pausing a routine, taking control of the agent's screen) are confirmed
 * here; back and the scrim cancel.
 */
export function Dialog({
  open,
  title,
  onCancel,
  children,
  actions,
}: {
  open: boolean
  title: string
  onCancel: () => void
  children?: ReactNode
  actions: ReactNode
}) {
  useBackHandler(() => {
    onCancel()
    return true
  }, open)
  if (!open) return null
  return (
    <Portal>
      <DialogFrame title={title} onCancel={onCancel} actions={actions}>
        {children}
      </DialogFrame>
    </Portal>
  )
}

function DialogFrame({
  title,
  onCancel,
  children,
  actions,
}: {
  title: string
  onCancel: () => void
  children: ReactNode
  actions: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const progress = useEntrance()
  const titleRef = useRef<HostInstance>(null)
  useInitialFocus(titleRef)
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          justifyContent: 'center',
          alignItems: 'center',
          paddingTop: insets.top + theme.space[6],
          paddingBottom: Math.max(keyboard, insets.bottom) + theme.space[6],
          paddingHorizontal: theme.space[5],
        },
      ]}
    >
      <Scrim progress={progress} onPress={onCancel} />
      <Animated.View
        style={{
          width: '100%',
          maxWidth: 440,
          gap: theme.space[3],
          padding: theme.space[5],
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surfaceRaised,
          boxShadow: theme.shadow.overlay,
          opacity: progress,
        }}
      >
        <Text
          ref={titleRef}
          accessibilityRole="header"
          style={[theme.text.title, { color: theme.colors.text }]}
        >
          {title}
        </Text>
        {children}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            gap: theme.space[2],
          }}
        >
          {actions}
        </View>
      </Animated.View>
    </View>
  )
}
