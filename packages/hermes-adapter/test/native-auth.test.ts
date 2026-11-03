import { CindlError } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  createPkcePair,
  NativeAuth,
  RestClient,
  webCryptoProvider,
  type LoopbackLeg,
  type SecretVault,
} from '../src/index.ts'
import { captureLog, fakeHermes, timers } from './harness.ts'

const crypto = webCryptoProvider()

function vault(available = true) {
  const map = new Map<string, string>()
  const writes: string[] = []
  const store: SecretVault & { map: Map<string, string>; writes: string[] } = {
    available,
    map,
    writes,
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      writes.push(key)
      map.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      map.delete(key)
      return Promise.resolve()
    },
  }
  return store
}

/** The system-browser leg: follow Hermes's 302 to the loopback redirect without listening on it. */
function browserLeg(rewrite: (callback: string) => string = (c) => c): LoopbackLeg {
  return {
    async authorize(buildUrl) {
      const response = await fetch(buildUrl('http://127.0.0.1:53682/callback'), {
        redirect: 'manual',
      })
      return rewrite(response.headers.get('location') ?? '')
    },
  }
}

async function signedIn(options: { available?: boolean } = {}) {
  const fake = await fakeHermes()
  const secrets = vault(options.available ?? true)
  const log = captureLog()
  const auth = new NativeAuth({
    origin: fake.origin,
    fetch: (url, init) => fetch(url, init),
    timers,
    secrets,
    crypto,
    diagnostics: log.diagnostics,
  })
  const identity = await auth.signIn(browserLeg())
  const rest = new RestClient({
    origin: fake.origin,
    fetch: (url, init) => fetch(url, init),
    timers,
    auth: auth.restAuth(),
    diagnostics: log.diagnostics,
  })
  return { fake, auth, rest, identity, secrets, log }
}

const count = (fake: { calls: Array<{ name: string }> }, name: string) =>
  fake.calls.filter((c) => c.name === name).length

describe('native PKCE sign-in', () => {
  it('signs in, keeps tokens only in the secret store and authenticates REST with them', async () => {
    const { fake, rest, identity, secrets, log } = await signedIn()
    expect(identity).toMatchObject({
      provider: 'basic',
      userId: 'fixture-owner',
      persistent: true,
    })
    expect([...secrets.map.keys()]).toEqual([
      `cindl.hermes.native-tokens.v1|${fake.origin}`,
    ])
    await expect(rest.me()).resolves.toMatchObject({ user_id: 'fixture-owner' })
    const stored = JSON.parse([...secrets.map.values()][0] as string) as {
      access_token: string
    }
    expect(log.text()).not.toContain(stored.access_token)
  })

  it('refreshes once after a 401 and retries the request', async () => {
    const { fake, rest } = await signedIn()
    fake.auth.expireAccessTokens()
    await expect(rest.me()).resolves.toMatchObject({ user_id: 'fixture-owner' })
    expect(count(fake, 'POST /auth/native/refresh')).toBe(1)
    expect(count(fake, 'GET /api/auth/me')).toBe(2)
  })

  it('shares one refresh between concurrent 401s so a rotated token is never replayed', async () => {
    const { fake, rest } = await signedIn()
    fake.auth.expireAccessTokens()
    await Promise.all([rest.me(), rest.skills(), rest.memory()])
    expect(count(fake, 'POST /auth/native/refresh')).toBe(1)
  })

  it('signs out locally when Hermes rejects the refresh token', async () => {
    const { fake, auth, rest, secrets } = await signedIn()
    fake.auth.revokeAll()
    const error = await rest.me().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CindlError)
    expect((error as CindlError).code).toBe('unauthenticated')
    expect(secrets.map.size).toBe(0)
    await expect(auth.identity()).resolves.toBeUndefined()
  })

  it('keeps the tokens when the auth provider is unreachable (503)', async () => {
    const { fake, rest, secrets } = await signedIn()
    fake.auth.refreshUnavailable = true
    fake.auth.expireAccessTokens()
    const error = await rest.me().catch((e: unknown) => e)
    expect((error as CindlError).code).toBe('unavailable')
    expect(secrets.map.size).toBe(1)
  })

  it('treats a code as single use: a wrong verifier burns it', async () => {
    const fake = await fakeHermes()
    const pkce = await createPkcePair(crypto)
    const response = await fetch(
      `${fake.origin}/auth/native/authorize?${new URLSearchParams({
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        redirect_uri: 'http://127.0.0.1:53682/callback',
        state: 'synthetic-state',
      }).toString()}`,
      { redirect: 'manual' },
    )
    const code =
      new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? ''
    const publicRest = new RestClient({
      origin: fake.origin,
      fetch: (url, init) => fetch(url, init),
      timers,
      auth: { kind: 'none' },
    })
    const wrong = await publicRest
      .nativeToken(code, 'x'.repeat(43))
      .catch((e: unknown) => e)
    expect((wrong as CindlError).code).toBe('invalid')
    const replay = await publicRest
      .nativeToken(code, pkce.verifier)
      .catch((e: unknown) => e)
    expect((replay as CindlError).code).toBe('invalid')
  })

  it('rejects a callback whose state does not match, before any token exchange', async () => {
    const fake = await fakeHermes()
    const auth = new NativeAuth({
      origin: fake.origin,
      fetch: (url, init) => fetch(url, init),
      timers,
      secrets: vault(),
      crypto,
    })
    const tampered = browserLeg((callback) => {
      const url = new URL(callback)
      url.searchParams.set('state', 'attacker-state')
      return url.toString()
    })
    await expect(auth.signIn(tampered)).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(count(fake, 'POST /auth/native/token')).toBe(0)
  })

  it('reports a sign-in the user declined', async () => {
    const fake = await fakeHermes({ nativeSignIn: 'deny' })
    const auth = new NativeAuth({
      origin: fake.origin,
      fetch: (url, init) => fetch(url, init),
      timers,
      secrets: vault(),
      crypto,
    })
    await expect(auth.signIn(browserLeg())).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'Hermes sign-in was cancelled or failed.',
    })
  })

  it('keeps tokens in memory only when the OS secret store is unavailable', async () => {
    const { identity, secrets, rest } = await signedIn({ available: false })
    expect(identity.persistent).toBe(false)
    expect(secrets.writes).toEqual([])
    await expect(rest.me()).resolves.toMatchObject({ user_id: 'fixture-owner' })
  })

  it('reloads stored tokens in a new client instance', async () => {
    const { fake, secrets } = await signedIn()
    const again = new NativeAuth({
      origin: fake.origin,
      fetch: (url, init) => fetch(url, init),
      timers,
      secrets,
      crypto,
    })
    await expect(again.identity()).resolves.toMatchObject({ userId: 'fixture-owner' })
  })
})
