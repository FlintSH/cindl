import { capabilityIds, type CindlEvent, type OpName } from '@cindl/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createSignedOutClient, SIGN_IN_PENDING_MESSAGE } from '../src/main/signed-out.ts'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('signed-out desktop client', () => {
  it('is honestly unconfigured, with every capability unknown and why', async () => {
    const client = createSignedOutClient({ forgetTokens: () => Promise.resolve() })
    const link = await client.call('link.get', {})
    expect(link).toMatchObject({
      phase: 'unconfigured',
      auth: 'native-pkce',
      connectionEpoch: 0,
    })
    expect(link.demo).toBeUndefined()
    const capabilities = await client.call('capabilities.get', {})
    expect(Object.keys(capabilities).sort()).toEqual([...capabilityIds].sort())
    for (const capability of Object.values(capabilities)) {
      expect(capability.state).toBe('unknown')
      expect(capability.reason).toMatch(/not signed in/)
      expect(capability.source.transport).toBe('none')
    }
  })

  it('names the last origin when one is known', async () => {
    const client = createSignedOutClient({
      origin: 'https://hermes.example.test',
      forgetTokens: () => Promise.resolve(),
    })
    expect(await client.call('link.get', {})).toMatchObject({
      phase: 'signed-out',
      server: { origin: 'https://hermes.example.test' },
    })
  })

  it('sends the state to a new subscriber', async () => {
    const client = createSignedOutClient({ forgetTokens: () => Promise.resolve() })
    const events: CindlEvent[] = []
    client.subscribe((event) => events.push(event))
    await flush()
    expect(events.map((event) => event.type)).toEqual([
      'link.changed',
      'capabilities.changed',
    ])
  })

  it('refuses sign-in until the Hermes transport is integrated, sending nothing', async () => {
    const client = createSignedOutClient({ forgetTokens: () => Promise.resolve() })
    await expect(
      client.call('auth.signIn', { origin: 'https://hermes.example.test' }),
    ).rejects.toMatchObject({ code: 'unavailable', message: SIGN_IN_PENDING_MESSAGE })
  })

  it('signs out locally', async () => {
    const forgetTokens = vi.fn(() => Promise.resolve())
    const client = createSignedOutClient({ forgetTokens })
    expect(await client.call('auth.signOut', {})).toEqual({ localOnly: true })
    expect(forgetTokens).toHaveBeenCalledTimes(1)
  })

  it.each<[OpName, object]>([
    ['conversations.list', {}],
    ['soul.read', {}],
    ['skills.list', {}],
    ['memory.overview', {}],
    ['display.status', {}],
  ])('refuses %s as unauthenticated', async (name, args) => {
    const client = createSignedOutClient({ forgetTokens: () => Promise.resolve() })
    await expect(client.call(name, args as never)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })
})
