import type { TextStyleName } from '@cindl/tokens'
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  Animated,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { useReducedMotion } from '../theme/motion.tsx'
import { useStyles, useTheme, type CindlTheme } from '../theme/theme.tsx'
import { ChevronRight, LoaderCircle, type LucideIcon } from './icons.ts'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
export type TextTone =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'accent'
  | 'onAccent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
export type Weight = 'regular' | 'medium' | 'semibold'

export function textColor(theme: CindlTheme, tone: TextTone): string {
  const { colors } = theme
  switch (tone) {
    case 'primary':
      return colors.text
    case 'secondary':
      return colors.textSecondary
    case 'tertiary':
      return colors.textTertiary
    case 'accent':
      return colors.accentText
    case 'onAccent':
      return colors.onAccent
    case 'success':
      return colors.success
    case 'warning':
      return colors.warning
    case 'danger':
      return colors.danger
    case 'info':
      return colors.info
  }
}

/** Visible keyboard focus (DESIGN.md: 2px focus colour, offset 2px). */
export function focusRing(theme: CindlTheme): ViewStyle {
  return {
    outlineColor: theme.colors.focus,
    outlineWidth: 2,
    outlineOffset: 2,
    outlineStyle: 'solid',
  }
}

/** Text in a DESIGN.md style. The system font scale applies; never disable it. */
export function Txt({
  variant = 'ui',
  tone = 'primary',
  weight,
  style,
  ...rest
}: TextProps & { variant?: TextStyleName; tone?: TextTone; weight?: Weight }) {
  const theme = useTheme()
  const base = theme.text[variant]
  const fontFamily = weight && variant !== 'code' ? theme.fonts[weight] : base.fontFamily
  return (
    <Text
      {...rest}
      style={[base, { fontFamily, color: textColor(theme, tone) }, style]}
    />
  )
}

export type ButtonVariant = 'default' | 'primary' | 'quiet' | 'danger'

export function Button({
  label,
  accessibilityLabel,
  accessibilityHint,
  icon: Icon,
  iconOnly = false,
  variant = 'default',
  disabled = false,
  busy = false,
  onPress,
  style,
  testID,
}: {
  label: string
  /** Spoken label when it differs from the visible one (TalkBack wording matches web aria-labels). */
  accessibilityLabel?: string
  accessibilityHint?: string
  icon?: LucideIcon
  /** Square 44dp icon button; `label` is then only spoken. */
  iconOnly?: boolean
  variant?: ButtonVariant
  disabled?: boolean
  busy?: boolean
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  testID?: string
}) {
  const theme = useTheme()
  const styles = useStyles(buttonStyles)
  const [focused, setFocused] = useState(false)
  const foreground =
    variant === 'primary'
      ? theme.colors.onAccent
      : variant === 'quiet'
        ? theme.colors.textSecondary
        : variant === 'danger'
          ? theme.colors.danger
          : theme.colors.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      {...(onPress ? { onPress } : {})}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={{ color: theme.colors.selection }}
      {...(testID ? { testID } : {})}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        pressed && variant === 'primary' ? styles.primaryPressed : null,
        iconOnly ? styles.iconOnly : null,
        disabled ? styles.disabled : null,
        focused ? focusRing(theme) : null,
        style,
      ]}
    >
      {Icon ? (
        <Icon size={iconOnly ? 18 : 16} color={foreground} strokeWidth={1.75} />
      ) : null}
      {iconOnly ? null : (
        <Text
          style={[
            theme.text.ui,
            { fontFamily: theme.fonts.medium, color: foreground, textAlign: 'center' },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  )
}

const buttonStyles = (theme: CindlTheme) => {
  const { colors, space, radius, layout } = theme
  return {
    button: {
      minHeight: layout.touchTarget,
      paddingHorizontal: space[3],
      paddingVertical: space[1],
      borderRadius: radius.md,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space[1.5],
      overflow: 'hidden',
    },
    default: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
    danger: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
    primary: { backgroundColor: colors.accent, borderColor: colors.accent },
    primaryPressed: {
      backgroundColor: colors.accentHover,
      borderColor: colors.accentHover,
    },
    quiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
    iconOnly: { width: layout.touchTarget, paddingHorizontal: 0 },
    disabled: { opacity: 0.55 },
  } satisfies Record<string, ViewStyle>
}

const badgeColors = (theme: CindlTheme, tone: Tone) => {
  const { colors } = theme
  switch (tone) {
    case 'neutral':
      return { background: colors.surfaceSunken, foreground: colors.textSecondary }
    case 'accent':
      return { background: colors.accentSubtle, foreground: colors.accentText }
    case 'success':
      return { background: colors.successSubtle, foreground: colors.success }
    case 'warning':
      return { background: colors.warningSubtle, foreground: colors.warning }
    case 'danger':
      return { background: colors.dangerSubtle, foreground: colors.danger }
    case 'info':
      return { background: colors.infoSubtle, foreground: colors.info }
  }
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: string }) {
  const theme = useTheme()
  const { background, foreground } = badgeColors(theme, tone)
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        minHeight: 20,
        justifyContent: 'center',
        paddingHorizontal: theme.space[1.5],
        borderRadius: theme.radius.pill,
        backgroundColor: background,
      }}
    >
      <Text style={[theme.text.caption, { color: foreground }]}>{children}</Text>
    </View>
  )
}

export function Dot({ tone = 'neutral' }: { tone?: Tone }) {
  const theme = useTheme()
  const { colors } = theme
  const color = {
    neutral: colors.textTertiary,
    accent: colors.accent,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
    info: colors.info,
  }[tone]
  return (
    <View
      accessible={false}
      importantForAccessibility="no"
      style={{
        width: 8,
        height: 8,
        borderRadius: theme.radius.pill,
        backgroundColor: color,
      }}
    />
  )
}

/** Section label: label size, 600 weight, uppercase, 0.04em tracking, tertiary colour. */
export function SectionTitle({ children }: { children: string }) {
  const theme = useTheme()
  return (
    <Text
      accessibilityRole="header"
      style={[
        theme.text.label,
        {
          fontFamily: theme.fonts.semibold,
          color: theme.colors.textTertiary,
          letterSpacing: +(0.04 * theme.text.label.fontSize).toFixed(2),
          textTransform: 'uppercase',
        },
      ]}
    >
      {children}
    </Text>
  )
}

export function Note({
  children,
  style,
}: {
  children: ReactNode
  style?: StyleProp<TextStyle>
}) {
  return (
    <Txt variant="label" tone="tertiary" {...(style ? { style } : {})}>
      {children}
    </Txt>
  )
}

/** Error copy; announced by TalkBack when it appears. */
export function ErrorText({ children }: { children: string }) {
  return (
    <Txt tone="danger" accessibilityRole="alert" accessibilityLiveRegion="assertive">
      {children}
    </Txt>
  )
}

/** "Nothing here" message: dashed border, secondary text. */
export function Empty({ children }: { children: string }) {
  const theme = useTheme()
  return (
    <View
      style={{
        padding: theme.space[4],
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.borderStrong,
        borderRadius: theme.radius.md,
      }}
    >
      <Txt tone="secondary">{children}</Txt>
    </View>
  )
}

/** Sunken explanatory box (unsupported capabilities, confirmations). */
export function Callout({ children }: { children: ReactNode }) {
  const theme = useTheme()
  return (
    <View
      style={{
        gap: theme.space[2],
        paddingVertical: theme.space[3],
        paddingHorizontal: theme.space[4],
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceSunken,
      }}
    >
      {children}
    </View>
  )
}

/** Bordered row list (DESIGN.md: rows, not cards). Children are rows. */
export function Rows({ children }: { children: ReactNode }) {
  const theme = useTheme()
  const items = Children.toArray(children).filter(isValidElement)
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
      }}
    >
      {items.map((item, index) => (
        <Fragment key={item.key ?? index}>
          {index > 0 ? (
            <View style={{ height: 1, backgroundColor: theme.colors.border }} />
          ) : null}
          {item}
        </Fragment>
      ))}
    </View>
  )
}

export function Row({
  title,
  detail,
  leading,
  aside,
  onPress,
  accessibilityLabel,
}: {
  title: string
  detail?: string | undefined
  leading?: ReactNode
  aside?: ReactNode
  onPress?: () => void
  accessibilityLabel?: string
}) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)
  const body = (
    <>
      <View style={{ flex: 1, minWidth: 160, gap: theme.space[0.5] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
          {leading}
          <Txt weight="medium" style={{ flexShrink: 1 }}>
            {title}
          </Txt>
        </View>
        {detail ? (
          <Txt variant="label" tone="secondary">
            {detail}
          </Txt>
        ) : null}
      </View>
      {aside ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          {aside}
        </View>
      ) : null}
      {onPress ? (
        <ChevronRight size={16} color={theme.colors.textTertiary} strokeWidth={1.75} />
      ) : null}
    </>
  )
  const layout: ViewStyle = {
    minHeight: theme.layout.touchTarget,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space[3],
    paddingVertical: theme.space[3],
    paddingHorizontal: theme.space[4],
  }
  if (!onPress) return <View style={layout}>{body}</View>
  return (
    <Pressable
      accessibilityRole="button"
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={{ color: theme.colors.selection }}
      style={[layout, focused ? focusRing(theme) : null]}
    >
      {body}
    </Pressable>
  )
}

/** Label/value pairs, stacked on phones (DESIGN.md facts lists). */
export function Facts({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: ReactNode }>
}) {
  const theme = useTheme()
  return (
    <View style={{ gap: theme.space[3] }}>
      {items.map((item) => (
        <View key={item.label} style={{ gap: theme.space[0.5] }}>
          <Txt variant="label" tone="tertiary">
            {item.label}
          </Txt>
          {typeof item.value === 'string' ? <Txt>{item.value}</Txt> : item.value}
        </View>
      ))}
    </View>
  )
}

/** A loader icon that turns while work runs and stands still under reduced motion. */
export function Spinner({ color, size = 14 }: { color: string; size?: number }) {
  const reduced = useReducedMotion()
  const [rotation] = useState(() => new Animated.Value(0))
  useEffect(() => {
    if (reduced) {
      rotation.setValue(0)
      return
    }
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1100,
        easing: (value) => value,
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [reduced, rotation])
  const rotate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  })
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <LoaderCircle size={size} color={color} strokeWidth={2} />
    </Animated.View>
  )
}
