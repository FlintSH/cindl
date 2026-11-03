import { createElement, type ReactNode, type Ref } from 'react'

/*
 * React Native's host layer for rendering the app's own components with
 * react-dom in Node tests (jsdom). React Native's Jest preset does the same
 * job: it replaces the native views and native modules and nothing else. Here
 * every component, hook, effect and handler above this layer is the shipped
 * code; only what the platform draws is replaced:
 *
 * - View, Text, TextInput and Pressable render a div, a span, a labelled
 *   textarea (or input) and a div;
 * - accessibility props become ARIA, as TalkBack reads them: the label is the
 *   accessible name, `accessibilityRole` the role ("header" is a heading),
 *   `accessibilityState` aria-disabled/selected/checked/busy/expanded, and a
 *   live region aria-live;
 * - `onPress` fires on a click unless `disabled` is set, as Pressable does
 *   (React Native 0.88.1 ignores `accessibilityState.disabled` for presses);
 * - styles are not drawn, animations end at once (a loop, like a spinner,
 *   never does), and TalkBack focus requests are recorded in `nativeLog`.
 *
 * Wired in by vitest.config.ts (an alias for `react-native`). Only the APIs the
 * rendered screens use are here, so a screen that needs another fails loudly.
 */

type Props = Record<string, unknown> & { children?: ReactNode }
type Press = (event: object) => void
interface PressState {
  pressed: boolean
  hovered: boolean
}

const ROLES: Record<string, string> = {
  alert: 'alert',
  button: 'button',
  header: 'heading',
  image: 'img',
  link: 'link',
  radio: 'radio',
  radiogroup: 'radiogroup',
  tab: 'tab',
  tablist: 'tablist',
}

interface A11yState {
  disabled?: boolean
  selected?: boolean
  checked?: boolean | 'mixed'
  busy?: boolean
  expanded?: boolean
}

/** The DOM attributes for a host element's accessibility props. */
function a11y(props: Props): Record<string, string> {
  const out: Record<string, string> = {}
  const label = props.accessibilityLabel ?? props['aria-label']
  if (typeof label === 'string') out['aria-label'] = label
  const role = props.accessibilityRole ?? props.role
  if (typeof role === 'string') {
    const mapped = ROLES[role]
    if (!mapped)
      throw new Error(`test/render/react-native.tsx: no ARIA role for "${role}"`)
    out.role = mapped
  }
  if (typeof props.accessibilityHint === 'string')
    out['aria-description'] = props.accessibilityHint
  const state = props.accessibilityState as A11yState | undefined
  if (props.disabled === true || state?.disabled === true) out['aria-disabled'] = 'true'
  if (state?.selected !== undefined) out['aria-selected'] = String(state.selected)
  if (state?.checked !== undefined) out['aria-checked'] = String(state.checked)
  if (state?.busy === true) out['aria-busy'] = 'true'
  if (state?.expanded !== undefined) out['aria-expanded'] = String(state.expanded)
  const live = props.accessibilityLiveRegion
  if (live === 'polite' || live === 'assertive') out['aria-live'] = live
  if (
    props.accessibilityElementsHidden === true ||
    props.importantForAccessibility === 'no-hide-descendants'
  )
    out['aria-hidden'] = 'true'
  if (typeof props.testID === 'string') out['data-testid'] = props.testID
  if (typeof props.nativeID === 'string') out.id = props.nativeID
  return out
}

export function View({ ref, children, ...props }: Props & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} data-rn="View" {...a11y(props)}>
      {children}
    </div>
  )
}

export function Text({
  ref,
  children,
  onPress,
  selectable,
  ...props
}: Props & { ref?: Ref<HTMLSpanElement>; onPress?: Press }) {
  return (
    <span
      ref={ref}
      data-rn="Text"
      {...(selectable === true ? { 'data-selectable': '' } : {})}
      {...a11y(props)}
      {...(onPress ? { onClick: () => onPress({}) } : {})}
    >
      {children}
    </span>
  )
}

export function TextInput({
  ref,
  value,
  defaultValue,
  onChangeText,
  editable,
  multiline,
  placeholder,
  ...props
}: Props & {
  ref?: Ref<HTMLTextAreaElement | HTMLInputElement>
  onChangeText?: (text: string) => void
}) {
  return createElement(multiline === true ? 'textarea' : 'input', {
    ref,
    'data-rn': 'TextInput',
    ...a11y(props),
    ...(value !== undefined ? { value } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(typeof placeholder === 'string' ? { placeholder } : {}),
    readOnly: editable === false,
    onChange: (event: { target: { value: string } }) =>
      onChangeText?.(event.target.value),
  })
}

export function Pressable({
  ref,
  children,
  onPress,
  disabled,
  accessible,
  focusable,
  ...props
}: Omit<Props, 'children'> & {
  ref?: Ref<HTMLDivElement>
  onPress?: Press
  children?: ReactNode | ((state: PressState) => ReactNode)
}) {
  const off = disabled === true
  const content =
    typeof children === 'function'
      ? children({ pressed: false, hovered: false })
      : children
  // Whether the view is a stop for a keyboard's focus on a device. Pressable
  // passes `accessible` and `focusable` (each true unless false); React Native
  // 0.88's view manager makes the view focusable for accessible={true}, and for
  // focusable={true} (which it applies last), so it is no stop only when both are false.
  const stop = accessible !== false || focusable !== false
  return (
    <div
      ref={ref}
      data-rn="Pressable"
      data-focusable={String(stop)}
      {...a11y({ ...props, disabled: off })}
      {...(!off && onPress ? { onClick: () => onPress({ nativeEvent: {} }) } : {})}
    >
      {content}
    </div>
  )
}

/**
 * What the screen asked of TalkBack, and of a hardware keyboard's focus
 * (modules/cindl-focus, through test/render/expo.ts), in order (cleared by
 * `resetNative`).
 */
export const nativeLog: Array<
  | { kind: 'focus'; node: unknown }
  | { kind: 'announce'; text: string }
  | { kind: 'keyboard-block'; node: unknown; blocked: boolean }
  | { kind: 'keyboard-focus'; node: unknown }
> = []

/** A view's tag, as the native side resolves it: here the element itself. */
export const findNodeHandle = (node: unknown) => node as number | null

export function resetNative() {
  nativeLog.length = 0
}

export const AccessibilityInfo = {
  isReduceMotionEnabled: () => Promise.resolve(false),
  isScreenReaderEnabled: () => Promise.resolve(false),
  addEventListener: () => ({ remove() {} }),
  sendAccessibilityEvent: (node: unknown, type: string) => {
    if (type === 'focus') nativeLog.push({ kind: 'focus', node })
  },
  announceForAccessibility: (text: string) => {
    nativeLog.push({ kind: 'announce', text })
  },
}

class AnimatedValue {
  value: number
  constructor(value: number) {
    this.value = value
  }
  setValue(value: number) {
    this.value = value
  }
  interpolate(config: unknown) {
    return { source: this, config }
  }
  stopAnimation(callback?: (value: number) => void) {
    callback?.(this.value)
  }
}

interface Animation {
  start(callback?: (result: { finished: boolean }) => void): void
  stop(): void
  reset(): void
}

/** An animation that ends as soon as it starts (its callback runs after the caller). */
const ending = (apply: () => void): Animation => ({
  start: (callback) => {
    apply()
    if (callback) queueMicrotask(() => callback({ finished: true }))
  },
  stop: () => undefined,
  reset: () => undefined,
})

const toValue = (value: AnimatedValue, config: { toValue: number }) =>
  ending(() => value.setValue(config.toValue))
const together = (animations: Animation[]) =>
  ending(() => {
    for (const animation of animations) animation.start()
  })

export const Animated = {
  Value: AnimatedValue,
  View,
  Text,
  timing: toValue,
  spring: toValue,
  parallel: together,
  sequence: together,
  /** A loop (a spinner) never ends. */
  loop: (): Animation => ({
    start: () => undefined,
    stop: () => undefined,
    reset: () => undefined,
  }),
}

const linear = (t: number) => t
export const Easing = {
  linear,
  ease: linear,
  quad: linear,
  cubic: linear,
  bezier: () => linear,
  in: (easing: (t: number) => number) => easing,
  out: (easing: (t: number) => number) => easing,
  inOut: (easing: (t: number) => number) => easing,
}

const fill = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const
export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  hairlineWidth: 1,
  absoluteFill: fill,
  absoluteFillObject: fill,
}

type BackListener = () => boolean | null | undefined
const backListeners: BackListener[] = []

export const BackHandler = {
  addEventListener: (_event: string, listener: BackListener) => {
    backListeners.push(listener)
    return {
      remove() {
        const at = backListeners.lastIndexOf(listener)
        if (at >= 0) backListeners.splice(at, 1)
      },
    }
  },
}

/** System back as Android sends it: the newest listener first, until one handles it. */
export function hardwareBack(): boolean {
  for (const listener of [...backListeners].reverse()) if (listener()) return true
  return false
}

export const Keyboard = {
  addListener: () => ({ remove() {} }),
  dismiss: () => undefined,
  isVisible: () => false,
}

/** A Pixel-sized phone, portrait. */
export const useWindowDimensions = () => ({
  width: 412,
  height: 915,
  scale: 2.625,
  fontScale: 1,
})
export const useColorScheme = () => 'light' as const

export const Platform = {
  OS: 'android' as const,
  Version: 36,
  select: <T,>(spec: { android?: T; native?: T; default?: T }) =>
    spec.android ?? spec.native ?? spec.default,
}
