import type { ColorRole } from './color.ts'

/** WCAG 2.2 relative luminance for an opaque `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match?.[1]) throw new Error(`Expected an opaque #RRGGBB colour, got ${hex}`)
  const value = match[1]
  const channel = (offset: number) => {
    const c = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Pairings used by shipped components and the minimum ratio each must meet.
 * 4.5 = WCAG AA body text; 3 = AA non-text UI (focus rings, input borders).
 */
export const requiredPairs: ReadonlyArray<{
  foreground: ColorRole
  backgrounds: readonly ColorRole[]
  minimum: number
}> = [
  {
    foreground: 'text',
    backgrounds: ['canvas', 'surface', 'surfaceRaised', 'surfaceSunken', 'accentSubtle'],
    minimum: 7,
  },
  {
    foreground: 'textSecondary',
    backgrounds: ['canvas', 'surface', 'surfaceRaised', 'surfaceSunken'],
    minimum: 4.5,
  },
  {
    foreground: 'textTertiary',
    backgrounds: ['canvas', 'surface', 'surfaceRaised', 'surfaceSunken'],
    minimum: 4.5,
  },
  {
    foreground: 'accentText',
    // surfaceSunken: "Needs you" on the conversation list's selected row.
    backgrounds: ['canvas', 'surface', 'surfaceRaised', 'surfaceSunken', 'accentSubtle'],
    minimum: 4.5,
  },
  { foreground: 'onAccent', backgrounds: ['accent', 'accentHover'], minimum: 4.5 },
  {
    foreground: 'success',
    backgrounds: ['canvas', 'surface', 'successSubtle'],
    minimum: 4.5,
  },
  {
    foreground: 'warning',
    backgrounds: ['canvas', 'surface', 'warningSubtle'],
    minimum: 4.5,
  },
  {
    foreground: 'danger',
    backgrounds: ['canvas', 'surface', 'dangerSubtle'],
    minimum: 4.5,
  },
  {
    foreground: 'info',
    // surfaceSunken: "Working" on the conversation list's selected row.
    backgrounds: ['canvas', 'surface', 'surfaceSunken', 'infoSubtle'],
    minimum: 4.5,
  },
  {
    foreground: 'focus',
    backgrounds: ['canvas', 'surface', 'surfaceRaised'],
    minimum: 3,
  },
  { foreground: 'borderStrong', backgrounds: ['canvas', 'surface'], minimum: 3 },
]
