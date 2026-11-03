/**
 * Non-colour scales shared by web (CSS custom properties) and Android
 * (numbers, density-independent pixels). Web converts px to rem so browser
 * zoom and user font size settings scale text; Android applies the OS font
 * scale to the same numbers.
 */

/** 4px grid. Index names match CSS `--space-N`. */
export const space = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const

/** Radii stop at 12px: no pillowy tiles. `pill` is for chips and status dots only. */
export const radius = { xs: 4, sm: 6, md: 8, lg: 12, pill: 999 } as const

export const fontFamily = {
  sans: 'Instrument Sans',
  mono: 'JetBrains Mono',
  /** CSS fallbacks if a bundled face fails to load. */
  sansFallback: 'ui-sans-serif, system-ui, sans-serif',
  monoFallback: 'ui-monospace, monospace',
  /**
   * Android registers one family name per static face (expo-font requirement).
   * Keys are CSS weights; values are the bundled file base names.
   */
  native: {
    sans: {
      400: 'InstrumentSans-Regular',
      500: 'InstrumentSans-Medium',
      600: 'InstrumentSans-SemiBold',
    },
    sansItalic: 'InstrumentSans-Italic',
    mono: { 400: 'JetBrainsMono-Regular', 500: 'JetBrainsMono-Medium' },
  },
} as const

export type TextStyleName =
  'caption' | 'label' | 'ui' | 'body' | 'title' | 'heading' | 'display' | 'code'

/** Size / line height in px, weight, tracking in em. */
export const textStyles: Readonly<
  Record<
    TextStyleName,
    {
      size: number
      lineHeight: number
      weight: 400 | 500 | 600
      tracking: number
      family: 'sans' | 'mono'
    }
  >
> = {
  caption: { size: 12, lineHeight: 16, weight: 500, tracking: 0.01, family: 'sans' },
  label: { size: 13, lineHeight: 18, weight: 500, tracking: 0.005, family: 'sans' },
  ui: { size: 14, lineHeight: 20, weight: 400, tracking: 0, family: 'sans' },
  body: { size: 16, lineHeight: 26, weight: 400, tracking: 0, family: 'sans' },
  title: { size: 18, lineHeight: 26, weight: 600, tracking: -0.005, family: 'sans' },
  heading: { size: 22, lineHeight: 30, weight: 600, tracking: -0.01, family: 'sans' },
  display: { size: 28, lineHeight: 36, weight: 600, tracking: -0.015, family: 'sans' },
  code: { size: 13, lineHeight: 20, weight: 400, tracking: 0, family: 'mono' },
}

/** Motion is brief and functional. Reduced motion collapses every duration to 0. */
export const motion = {
  duration: { fast: 120, base: 180, slow: 240 },
  easing: {
    standard: [0.2, 0, 0, 1],
    enter: [0, 0, 0, 1],
    exit: [0.4, 0, 1, 1],
  },
} as const

export const layout = {
  /** Narrow navigation spine on expanded layouts. */
  spineWidth: 72,
  /** Comfortable reading measure for conversation text. */
  readingMeasure: 720,
  /** Contextual working margin (evidence, approval, computer). */
  marginWidth: 400,
  /** Minimum touch target on touch layouts and Android. */
  touchTarget: 44,
  /** Minimum pointer target on expanded pointer layouts. */
  pointerTarget: 32,
  breakpoints: { medium: 768, expanded: 1024, wide: 1280 },
} as const

export const elevation = {
  light: {
    raised: '0 1px 2px rgba(28, 25, 21, 0.06), 0 0 0 1px rgba(28, 25, 21, 0.04)',
    overlay: '0 12px 32px rgba(28, 25, 21, 0.14), 0 0 0 1px rgba(28, 25, 21, 0.06)',
  },
  dark: {
    raised: '0 1px 2px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.03)',
    overlay: '0 12px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.05)',
  },
} as const

export const zIndex = {
  spine: 10,
  margin: 20,
  sheet: 40,
  popover: 50,
  toast: 60,
} as const
