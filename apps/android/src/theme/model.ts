import {
  elevation,
  fontFamily,
  layout,
  motion,
  nativeColors,
  nativeTextStyle,
  radius,
  space,
  type NativeTextStyle,
  type TextStyleName,
  type Theme,
  type ThemeName,
} from '@cindl/tokens'

export type ThemePreference = 'system' | 'light' | 'dark'

export interface CindlTheme {
  name: ThemeName
  colors: Theme
  /** DESIGN.md text styles. The OS font scale applies on top (allowFontScaling stays on). */
  text: Readonly<Record<TextStyleName, NativeTextStyle>>
  /** One family per static face: Android selects weight by family, never by fontWeight. */
  fonts: {
    regular: string
    medium: string
    semibold: string
    italic: string
    mono: string
    monoMedium: string
  }
  /** CSS box-shadow strings from @cindl/tokens; React Native renders them on Android 9+. */
  shadow: { raised: string; overlay: string }
  space: typeof space
  radius: typeof radius
  layout: typeof layout
  motion: typeof motion
}

const textStyleNames: readonly TextStyleName[] = [
  'caption',
  'label',
  'ui',
  'body',
  'title',
  'heading',
  'display',
  'code',
]

export function buildTheme(name: ThemeName): CindlTheme {
  const text = Object.fromEntries(
    textStyleNames.map((style) => [style, nativeTextStyle(style)]),
  ) as Record<TextStyleName, NativeTextStyle>
  return {
    name,
    colors: nativeColors(name),
    text,
    fonts: {
      regular: fontFamily.native.sans[400],
      medium: fontFamily.native.sans[500],
      semibold: fontFamily.native.sans[600],
      italic: fontFamily.native.sansItalic,
      mono: fontFamily.native.mono[400],
      monoMedium: fontFamily.native.mono[500],
    },
    shadow: elevation[name],
    space,
    radius,
    layout,
    motion,
  }
}

/** The owner's preference wins; "system" follows Android's dark theme setting. */
export function resolveThemeName(
  preference: ThemePreference,
  system: string | null | undefined,
): ThemeName {
  if (preference !== 'system') return preference
  return system === 'dark' ? 'dark' : 'light'
}
