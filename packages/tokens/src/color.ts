/**
 * Semantic colour roles. Components use roles, never raw values, so the
 * light ("mineral") and dark ("graphite") themes stay one design.
 *
 * Every text/background pairing that ships is listed in ./contrast.ts and is
 * tested against WCAG 2.2 thresholds. Change a value here and the test tells
 * you whether the pairing still passes.
 */
export const colorRoles = [
  'canvas',
  'surface',
  'surfaceRaised',
  'surfaceSunken',
  'border',
  'borderStrong',
  'text',
  'textSecondary',
  'textTertiary',
  'accent',
  'accentHover',
  'onAccent',
  'accentText',
  'accentSubtle',
  'focus',
  'success',
  'successSubtle',
  'warning',
  'warningSubtle',
  'danger',
  'dangerSubtle',
  'info',
  'infoSubtle',
  'scrim',
  'selection',
] as const

export type ColorRole = (typeof colorRoles)[number]
export type ThemeName = 'light' | 'dark'
export type Theme = Readonly<Record<ColorRole, string>>

/** Warm mineral light: paper-like neutrals with a restrained ember accent. */
const light: Theme = {
  canvas: '#F4F1EB',
  surface: '#FAF8F4',
  surfaceRaised: '#FDFCFA',
  surfaceSunken: '#EAE5DC',
  border: '#DDD6CA',
  borderStrong: '#8C8276',
  text: '#1C1915',
  textSecondary: '#544C43',
  textTertiary: '#6B6257',
  accent: '#B0441A',
  accentHover: '#963914',
  onAccent: '#FFFFFF',
  accentText: '#A03D16',
  accentSubtle: '#F5E2D6',
  focus: '#B0441A',
  success: '#2D6A3E',
  successSubtle: '#E1EEE3',
  warning: '#855000',
  warningSubtle: '#F6EAD3',
  danger: '#A3302A',
  dangerSubtle: '#F6DEDB',
  info: '#2B5C88',
  infoSubtle: '#DDE8F2',
  scrim: 'rgba(28, 25, 21, 0.32)',
  selection: 'rgba(176, 68, 26, 0.18)',
}

/** Warm graphite dark: low-glare charcoal, the ember accent lifted for contrast. */
const dark: Theme = {
  canvas: '#161412',
  surface: '#1D1A17',
  surfaceRaised: '#24201C',
  surfaceSunken: '#110F0D',
  border: '#2F2A25',
  borderStrong: '#766C61',
  text: '#EEE8DF',
  textSecondary: '#BCB2A6',
  textTertiary: '#978D81',
  accent: '#E0743F',
  accentHover: '#EA8452',
  onAccent: '#1B0E07',
  accentText: '#EF8D5B',
  accentSubtle: '#3A2219',
  focus: '#EF8D5B',
  success: '#7BC48E',
  successSubtle: '#1D2E22',
  warning: '#E3B25C',
  warningSubtle: '#33291A',
  danger: '#EE8A80',
  dangerSubtle: '#3A201D',
  info: '#88B4E0',
  infoSubtle: '#1B2733',
  scrim: 'rgba(0, 0, 0, 0.56)',
  selection: 'rgba(239, 141, 91, 0.24)',
}

export const themes: Readonly<Record<ThemeName, Theme>> = { light, dark }
