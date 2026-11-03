// @vitest-environment node
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const files = globSync('**/*.css', { cwd: root })

/** Rule blocks (selector + declarations) in a stylesheet, ignoring nesting levels above one. */
function blocks(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (m) => ({
      selector: (m[1] ?? '').trim(),
      body: m[2] ?? '',
    }),
  )
}

describe('web stylesheet rules', () => {
  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  // Regression: visually hidden (absolutely positioned) helpers inside a scroll
  // container without a containing block were positioned against the page and
  // stretched the document (outer scrollbar, 1423px document in a 795px window).
  it.each(files)('every scroll container in %s is a containing block', (file) => {
    const offenders = blocks(readFileSync(root + file, 'utf8'))
      .filter(
        (b) =>
          /overflow(-x|-y)?\s*:\s*(auto|scroll)/.test(b.body) &&
          !/\bposition\s*:/.test(b.body),
      )
      .map((b) => b.selector)
    expect(offenders).toEqual([])
  })

  it.each(files)('%s uses colour tokens, not raw colour literals', (file) => {
    const raw = blocks(readFileSync(root + file, 'utf8')).flatMap((b) =>
      [...b.body.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)].map(
        (m) => `${b.selector}: ${m[0]}`,
      ),
    )
    expect(raw).toEqual([])
  })
})
