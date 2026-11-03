import { themes, type ThemeName } from './color.ts'
import { fontFamily, textStyles, type TextStyleName } from './scale.ts'

export interface NativeTextStyle {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
}

/**
 * React Native text styles. Android needs a distinct family per static face,
 * so weight is encoded in `fontFamily` rather than `fontWeight`.
 */
export function nativeTextStyle(name: TextStyleName): NativeTextStyle {
  const style = textStyles[name]
  const fontFamilyName =
    style.family === 'mono'
      ? fontFamily.native.mono[style.weight === 400 ? 400 : 500]
      : fontFamily.native.sans[style.weight]
  return {
    fontFamily: fontFamilyName,
    fontSize: style.size,
    lineHeight: style.lineHeight,
    letterSpacing: +(style.tracking * style.size).toFixed(2),
  }
}

export function nativeColors(name: ThemeName) {
  return themes[name]
}

/** File base names that the Android app must bundle (see apps/android/app.config.ts). */
export const nativeFontFiles = [
  'instrument-sans/InstrumentSans-Regular.ttf',
  'instrument-sans/InstrumentSans-Medium.ttf',
  'instrument-sans/InstrumentSans-SemiBold.ttf',
  'instrument-sans/InstrumentSans-Italic.ttf',
  'jetbrains-mono/JetBrainsMono-Regular.ttf',
  'jetbrains-mono/JetBrainsMono-Medium.ttf',
] as const
