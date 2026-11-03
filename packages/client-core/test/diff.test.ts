import { describe, expect, it } from 'vitest'
import { diffLines, diffStats } from '../src/diff.ts'

describe('diffLines', () => {
  it('reports unchanged, added and removed lines in order', () => {
    const { lines, exact } = diffLines('a\nb\nc', 'a\nc\nd')
    expect(exact).toBe(true)
    expect(lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ])
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 })
  })

  it('treats identical text as no change', () => {
    expect(diffStats(diffLines('x\ny', 'x\ny').lines)).toEqual({ added: 0, removed: 0 })
  })

  it('falls back to a full replacement for very large inputs', () => {
    const big = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n')
    const result = diffLines(big, big + '\nmore')
    expect(result.exact).toBe(false)
  })
})
