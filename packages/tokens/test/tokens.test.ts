import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  colorRoles,
  contrastRatio,
  nativeFontFiles,
  renderFontsCss,
  renderTokensCss,
  requiredPairs,
  themes,
} from '../src/index.ts'

describe('colour contrast', () => {
  for (const [name, theme] of Object.entries(themes)) {
    for (const pair of requiredPairs) {
      for (const background of pair.backgrounds) {
        it(`${name}: ${pair.foreground} on ${background} >= ${pair.minimum}:1`, () => {
          expect(
            contrastRatio(theme[pair.foreground], theme[background]),
          ).toBeGreaterThanOrEqual(pair.minimum)
        })
      }
    }
  }

  it('defines every role in both themes', () => {
    for (const theme of Object.values(themes))
      expect(Object.keys(theme).sort()).toEqual([...colorRoles].sort())
  })
})

describe('generated CSS', () => {
  it('matches the committed tokens.css and fonts.css', async () => {
    const read = (file: string) =>
      readFile(new URL(`../generated/${file}`, import.meta.url), 'utf8')
    expect(await read('tokens.css')).toBe(renderTokensCss())
    expect(await read('fonts.css')).toBe(renderFontsCss())
  })

  it('references only bundled font files that exist, with checksums', async () => {
    const sums = await readFile(new URL('../fonts/SHA256SUMS', import.meta.url), 'utf8')
    const referenced = [
      ...renderFontsCss().matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g),
    ].map((m) => m[1])
    for (const file of [...referenced, ...nativeFontFiles])
      expect(sums).toContain(`  ${file}\n`)
  })
})
