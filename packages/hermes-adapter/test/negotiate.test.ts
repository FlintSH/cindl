import { capabilityIds, CapabilityMap, type CapabilityId } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  negotiateCapabilities,
  unsupportedReasons,
  type Handshake,
} from '../src/index.ts'

const checkedAt = '2026-06-02T08:00:00.000Z'
const sidecar: Handshake = {
  connectionEpoch: 1,
  replayEpoch: 'e1',
  previousReplayEpoch: undefined,
  authority: 'legacy-sidecar-v8',
  sessionAuthority: false,
  heartbeat: true,
  serverRequests: ['approval', 'clarify', 'sudo'],
  declinesNotShown: true,
  perSessionExclusiveSubmit: true,
}
const running = { supported: true, installed: true, running: true }
const state = (map: CapabilityMap, id: CapabilityId) => map[id]?.state

describe('capability negotiation', () => {
  it('produces schema-valid capabilities with a reason for everything not available', () => {
    for (const map of [
      negotiateCapabilities({ checkedAt, signedIn: false }),
      negotiateCapabilities({
        checkedAt,
        signedIn: true,
        handshake: sidecar,
        display: running,
      }),
      negotiateCapabilities({
        checkedAt,
        signedIn: true,
        handshake: { ...sidecar, authority: 'canonical', sessionAuthority: true },
      }),
    ]) {
      expect(CapabilityMap.parse(map)).toEqual(map)
      for (const capability of Object.values(map))
        if (capability.state !== 'available')
          expect(capability.reason, capability.id).toBeTruthy()
    }
  })

  it('keeps unsupported features unsupported in every state', () => {
    for (const input of [
      { checkedAt, signedIn: false },
      { checkedAt, signedIn: true, handshake: sidecar, display: running },
    ]) {
      const map = negotiateCapabilities(input)
      for (const id of Object.keys(unsupportedReasons) as CapabilityId[])
        expect(state(map, id)).toBe('unsupported')
      expect(state(map, 'presence.unified')).toBe('unavailable')
    }
  })

  it('never reports anything as working while signed out or offline', () => {
    const map = negotiateCapabilities({ checkedAt, signedIn: false })
    expect(
      Object.values(map).filter((c) => c.state === 'available' || c.state === 'limited'),
    ).toEqual([])
  })

  it('maps an online sidecar connection', () => {
    const map = negotiateCapabilities({
      checkedAt,
      signedIn: true,
      handshake: sidecar,
      display: running,
      soulProfile: 'named',
    })
    expect(state(map, 'chat.stream')).toBe('available')
    expect(state(map, 'sessions.replay')).toBe('limited')
    expect(state(map, 'skills.write')).toBe('limited')
    expect(state(map, 'soul.write')).toBe('limited')
    expect(state(map, 'computer.view')).toBe('limited')
    expect(state(map, 'computer.control')).toBe('available')
    expect(map['requests.approval']?.source).toMatchObject({ transport: 'rpc' })
  })

  it('shows the live picture only where the platform can open the screen socket', () => {
    const online = { checkedAt, signedIn: true, handshake: sidecar, display: running }
    const limited = negotiateCapabilities(online)['computer.view']
    expect(limited?.state).toBe('limited')
    expect(limited?.reason).toMatch(/cannot open the screen socket/)
    expect(
      negotiateCapabilities({ ...online, liveView: true })['computer.view'],
    ).toMatchObject({
      state: 'available',
      source: { transport: 'rpc', endpoint: 'display.observe → /api/display/ws' },
    })
    // A stopped screen stays unavailable either way: watching never starts it.
    const stopped = negotiateCapabilities({
      ...online,
      liveView: true,
      display: { ...running, running: false },
    })
    expect(stopped['computer.view']?.state).toBe('unavailable')
  })

  it('offers SOUL.md only once the profile it names is known', () => {
    const online = { checkedAt, signedIn: true, handshake: sidecar, display: running }
    expect(negotiateCapabilities(online)['soul.read']).toBeUndefined()
    expect(negotiateCapabilities(online)['soul.write']).toBeUndefined()
    const unnamed = negotiateCapabilities({ ...online, soulProfile: 'unnamed' })
    expect(unnamed['soul.write']?.state).toBe('unavailable')
    expect(unnamed['soul.write']?.reason).toMatch(/no profile name addresses/)
    expect(
      negotiateCapabilities({ ...online, soulProfile: 'named' })['soul.read']?.state,
    ).toBe('available')
  })

  it('reports approvals unavailable when Hermes does not offer them on this connection', () => {
    const map = negotiateCapabilities({
      checkedAt,
      signedIn: true,
      handshake: { ...sidecar, serverRequests: ['clarify'] },
    })
    expect(state(map, 'requests.approval')).toBe('unavailable')
    expect(state(map, 'requests.clarify')).toBe('available')
  })

  it('leaves the agent screen unknown until probed and never implies Cindl can start it', () => {
    const unprobed = negotiateCapabilities({
      checkedAt,
      signedIn: true,
      handshake: sidecar,
    })
    expect(unprobed['computer.view']).toBeUndefined()
    const stopped = negotiateCapabilities({
      checkedAt,
      signedIn: true,
      handshake: sidecar,
      display: { ...running, running: false },
    })
    expect(stopped['computer.view']?.state).toBe('unavailable')
    expect(stopped['computer.view']?.reason).toMatch(/never starts/)
    const missing = negotiateCapabilities({
      checkedAt,
      signedIn: true,
      handshake: sidecar,
      display: { ...running, installed: false },
    })
    expect(state(missing, 'computer.control')).toBe('unsupported')
  })

  it('does not use canonical sessions it cannot drive', () => {
    const map = negotiateCapabilities({
      checkedAt,
      signedIn: true,
      handshake: { ...sidecar, authority: 'canonical', sessionAuthority: true },
    })
    expect(state(map, 'chat.stream')).toBe('unsupported')
    expect(state(map, 'skills.read')).toBe('available')
  })

  it('offers memory entries only when the learning routes answered', () => {
    const base = { checkedAt, signedIn: true, handshake: sidecar }
    expect(
      state(negotiateCapabilities({ checkedAt, signedIn: false }), 'memory.text'),
    ).toBe('unavailable')
    // Not probed yet (or the probe failed): left out, which reads as unknown.
    expect(state(negotiateCapabilities(base), 'memory.text')).toBeUndefined()
    expect(
      state(negotiateCapabilities({ ...base, memory: 'responds' }), 'memory.text'),
    ).toBe('available')
    const missing = negotiateCapabilities({ ...base, memory: 'missing' })['memory.text']
    expect(missing?.state).toBe('unsupported')
    expect(missing?.reason).toMatch(/never reads memory files through filesystem routes/)
  })

  it('only uses known capability ids', () => {
    const map = negotiateCapabilities({
      checkedAt,
      signedIn: true,
      handshake: sidecar,
      display: running,
    })
    for (const id of Object.keys(map)) expect(capabilityIds).toContain(id)
  })
})
