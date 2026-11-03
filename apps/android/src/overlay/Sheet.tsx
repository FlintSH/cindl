import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import { giveKeyboardFocus } from './keyboardFocus.ts'
import {
  justPressed,
  takeFocusClaim,
  useFocusFallback,
  type FocusTarget,
} from './opener.ts'
import { Portal } from './Portal.tsx'

type HostRef = { current: HostInstance | null }

/**
 * Once an overlay is on screen, moves TalkBack focus to its title and a
 * hardware keyboard's focus to its first control (the frame's).
 */
function useInitialFocus(title: HostRef, frame: HostRef) {
  useEffect(() => {
    const timer = setTimeout(() => {
      if (title.current) AccessibilityInfo.sendAccessibilityEvent(title.current, 'focus')
      giveKeyboardFocus(frame.current)
    }, 60)
    return () => clearTimeout(timer)
  }, [title, frame])
}

/**
 * Gives TalkBack focus, and a hardware keyboard's, back when the overlay
 * closes: to the control that opened it; when that control is gone (or
 * nothing opened it, as with system back), to the overlay's `returnFocus`,
 * then to the screen's fallback (a section's or page's heading, the
 * conversation switcher), so it never lands on nothing. Not when the action
 * that closed it moved focus itself (`claimFocus`).
 */
function useFocusReturn(targets: Array<FocusTarget | undefined>) {
  const [opener] = useState(justPressed)
  const latest = useRef(targets)
  useLayoutEffect(() => {
    latest.current = targets
  })
  useEffect(
    () => () => {
      const claimed = takeFocusClaim()
      setTimeout(() => {
        if (claimed) return
        let node = opener?.current
        for (const target of latest.current) node ??= target?.()
        if (!node) return
        AccessibilityInfo.sendAccessibilityEvent(node, 'focus')
        giveKeyboardFocus(node)
      }, 60)
    },
    [opener],
  )
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
  returnFocus,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  headerAside?: ReactNode
  /** Where focus goes on close when the control that opened the sheet is gone. */
  returnFocus?: FocusTarget
  children: ReactNode
}) {
  const fallback = useFocusFallback()
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
        returnTo={[returnFocus, fallback]}
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
  returnTo,
  children,
}: {
  title: string
  closeLabel: string
  onClose: () => void
  headerAside: ReactNode
  returnTo: Array<FocusTarget | undefined>
  children: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const { height } = useWindowDimensions()
  const progress = useEntrance()
  const titleRef = useRef<HostInstance>(null)
  const frameRef = useRef<HostInstance>(null)
  useInitialFocus(titleRef, frameRef)
  useFocusReturn(returnTo)
  const bottom = keyboard > 0 ? Math.max(keyboard, insets.bottom) : insets.bottom
  return (
    <View style={StyleSheet.absoluteFill}>
      <Scrim progress={progress} onPress={onClose} />
      <Animated.View
        ref={frameRef}
        collapsable={false}
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
  returnFocus,
  children,
  actions,
}: {
  open: boolean
  title: string
  onCancel: () => void
  /** Where focus goes on close when the control that opened the dialog is gone. */
  returnFocus?: FocusTarget
  children?: ReactNode
  actions: ReactNode
}) {
  const fallback = useFocusFallback()
  useBackHandler(() => {
    onCancel()
    return true
  }, open)
  if (!open) return null
  return (
    <Portal>
      <DialogFrame
        title={title}
        onCancel={onCancel}
        actions={actions}
        returnTo={[returnFocus, fallback]}
      >
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
  returnTo,
}: {
  title: string
  onCancel: () => void
  children: ReactNode
  actions: ReactNode
  returnTo: Array<FocusTarget | undefined>
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const progress = useEntrance()
  const titleRef = useRef<HostInstance>(null)
  const frameRef = useRef<HostInstance>(null)
  useInitialFocus(titleRef, frameRef)
  useFocusReturn(returnTo)
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
        ref={frameRef}
        collapsable={false}
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
