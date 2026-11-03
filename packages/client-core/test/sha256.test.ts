import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/sha256.ts'

describe('sha256Hex', () => {
  it.each([
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'ünïcødé ✓ 🔥',
    'x'.repeat(10_000),
  ])('matches node:crypto for %#', (input) => {
    expect(sha256Hex(input)).toBe(
      createHash('sha256').update(input, 'utf8').digest('hex'),
    )
  })
})
