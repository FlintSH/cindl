import { describe, expect, it } from 'vitest'
import {
  capabilityIds,
  cindlEventTypes,
  clientOps,
  CONTRACTS_VERSION,
  isOpName,
  opNames,
  parseOpArgs,
  ServerRequest,
} from '../src/index.ts'

describe('client operation registry', () => {
  it('declares a capability that exists for every gated operation', () => {
    for (const name of opNames) {
      const capability = (clientOps[name] as { capability?: string }).capability
      if (capability) expect(capabilityIds).toContain(capability)
    }
  })

  it('requires explicit confirmation for owner edits', () => {
    for (const name of [
      'skills.write',
      'soul.write',
      'routines.setEnabled',
      'display.acquireControl',
    ] as const) {
      const base =
        name === 'skills.write'
          ? { name: 'example', content: 'x', expectedVersion: 'a'.repeat(64) }
          : name === 'soul.write'
            ? { content: 'x', expectedVersion: 'a'.repeat(64) }
            : name === 'routines.setEnabled'
              ? { id: 'job-1', enabled: false }
              : {}
      expect(() => parseOpArgs(name, base)).toThrow()
      expect(() => parseOpArgs(name, { ...base, confirm: false })).toThrow()
      expect(parseOpArgs(name, { ...base, confirm: true })).toMatchObject({
        confirm: true,
      })
    }
  })

  it('rejects edits without the version that was reviewed', () => {
    expect(() =>
      parseOpArgs('soul.write', {
        content: 'x',
        expectedVersion: 'stale',
        confirm: true,
      }),
    ).toThrow()
  })

  it('rejects unknown operations and does not offer a passthrough', () => {
    expect(isOpName('shell.exec')).toBe(false)
    expect(isOpName('toString')).toBe(false)
    expect(() => parseOpArgs('rpc.call' as never, {})).toThrow(/Unknown Cindl operation/)
    expect(opNames.some((name) => /exec|vault|passthrough|raw/i.test(name))).toBe(false)
  })

  it('only answers approvals with Hermes choices, never approve-all', () => {
    expect(() =>
      parseOpArgs('request.answer', {
        rpcId: 7,
        connectionEpoch: 1,
        answer: { kind: 'approval', choice: 'always' },
      }),
    ).toThrow()
    expect(ServerRequest.shape.choices.element.options).toEqual(['once', 'deny'])
  })
})

describe('contract surface', () => {
  it('is versioned and enumerable for docs coverage', () => {
    expect(CONTRACTS_VERSION).toBe(1)
    expect(new Set(cindlEventTypes).size).toBe(cindlEventTypes.length)
    expect(new Set(capabilityIds).size).toBe(capabilityIds.length)
  })
})
