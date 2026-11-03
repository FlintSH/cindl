import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { HERMES_BASELINE } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  answeredServerRequests,
  canonicalMethods,
  handledNotifications,
  sidecarMethods,
} from '../src/upstream-surface.ts'

const subsetUrl = new URL('../upstream/v0.22.5/contract-subset.json', import.meta.url)
const subset = JSON.parse(await readFile(subsetUrl, 'utf8')) as {
  provenance: { tag: string; commit: string; sha256: string }
  methods: Array<{ name: string }>
  canonicalMethods: Array<{ name: string }>
  serverRequests: Array<{ name: string }>
  notifications: Array<{ name: string }>
  components: { schemas: Record<string, unknown> }
}
const names = (list: Array<{ name: string }>) => list.map((entry) => entry.name)

describe('vendored Hermes contract subset', () => {
  it('is pinned to the verified baseline', () => {
    expect(subset.provenance.tag).toBe(HERMES_BASELINE.tag)
    expect(subset.provenance.commit).toBe(HERMES_BASELINE.commit)
    expect(subset.provenance.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('contains exactly the surface the adapter is allowed to use', () => {
    expect(names(subset.methods)).toEqual([...sidecarMethods])
    expect(names(subset.canonicalMethods)).toEqual([...canonicalMethods])
    expect(names(subset.serverRequests)).toEqual([...answeredServerRequests])
    expect(names(subset.notifications)).toEqual([...handledNotifications])
  })

  it('resolves every schema reference', () => {
    const text = JSON.stringify(subset)
    for (const [, ref] of text.matchAll(/"#\/components\/schemas\/([^"]+)"/g))
      expect(subset.components.schemas, `missing schema ${ref}`).toHaveProperty([
        ref as string,
      ])
  })

  it('is byte-stable (regenerate with scripts/extract-upstream.ts, never edit)', async () => {
    const raw = await readFile(subsetUrl, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(createHash('sha256').update(raw).digest('hex')).toMatch(/^[a-f0-9]{64}$/)
  })
})
