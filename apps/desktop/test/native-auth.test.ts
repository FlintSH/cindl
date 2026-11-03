import type { KeyValueStore } from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'
import { webCryptoProvider } from '@cindl/hermes-adapter'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src/main/log.ts'
import { createLoopbackAuthorizer } from '../src/main/platform/loopback.ts'
import {
  createNativeAuth,
  expiresAtMs,
  ORIGIN_KEY,
  REFRESH_MARGIN_MS,
  tokenKey,
} from '../src/main/platform/native-auth.ts'
import {
  normalizeHermesOrigin,
  trustedStoredOrigin,
} from '../src/main/platform/origin-policy.ts'
import {
  createMemorySecretStore,
  createSecretStore,
} from '../src/main/platform/secret-store.ts'
import {
  browserFollowsRedirect,
  startFakeHermes,
  type FakeHermes,
} from './support/fake-hermes.ts'

function memoryKv(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: (key) => Promise.resolve(data.get(key)),
    set: (key, value) => {
      data.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      data.delete(key)
      return Promise.resolve()
    },
  }
}

let hermes: FakeHermes
let lines: string[]
beforeEach(async () => {
  hermes = await startFakeHermes()
  lines = []
})
afterEach(() => hermes.close())

function setup(
  options: {
    openBrowser?: (url: string) => Promise<void>
    now?: () => number
    confirmSignIn?: (origin: string) => Promise<boolean>
  } = {},
) {
  const secrets = createMemorySecretStore('test')
  const kv = memoryKv()
  const fetch = vi.fn(globalThis.fetch)
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) })
  const authorizer = createLoopbackAuthorizer({
    openBrowser: options.openBrowser ?? browserFollowsRedirect,
    timeoutMs: 5_000,
    log,
  })
  const auth = createNativeAuth({
    fetch,
    crypto: webCryptoProvider(),
    authorizer,
    secrets,
    kv,
    log,
    confirmSignIn: options.confirmSignIn ?? (() => Promise.resolve(true)),
    ...(options.now ? { now: options.now } : {}),
  })
  return { auth, secrets, kv, fetch }
}

describe('Hermes origin policy (R4)', () => {
  it.each([
    ['https://hermes.example.test', 'https://hermes.example.test'],
    ['https://hermes.example.test/', 'https://hermes.example.test'],
    ['HTTPS://Hermes.Example.Test:443', 'https://hermes.example.test'],
    ['https://hermes.example.test:9119', 'https://hermes.example.test:9119'],
    ['http://127.0.0.1:9119', 'http://127.0.0.1:9119'],
    ['http://[::1]:9119/', 'http://[::1]:9119'],
    ['https://127.0.0.1', 'https://127.0.0.1'],
    // The URL parser removes a lone dot segment; only the origin is kept.
    ['https://hermes.example.test/.', 'https://hermes.example.test'],
  ])('accepts %s as %s', (input, origin) => {
    expect(normalizeHermesOrigin(input)).toBe(origin)
  })

  it.each([
    ['plain http to another machine', 'http://hermes.example.test'],
    ['plain http to a LAN address', 'http://192.0.2.10:9119'],
    ['plain http to localhost by name', 'http://localhost:9119'],
    ['plain http to another loopback address', 'http://127.0.0.2:9119'],
    ['a trailing-dot host', 'https://hermes.example.test.'],
    ['port 0', 'https://hermes.example.test:0'],
    ['userinfo', 'https://owner:pw@hermes.example.test'],
    ['a user name', 'https://owner@hermes.example.test'],
    ['a path', 'https://hermes.example.test/hermes'],
    ['a double slash', 'https://hermes.example.test//'],
    ['a query', 'https://hermes.example.test/?next=x'],
    ['an empty query', 'https://hermes.example.test?'],
    ['a fragment', 'https://hermes.example.test/#x'],
    ['a websocket URL', 'wss://hermes.example.test'],
    ['a file URL', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['a bare host', 'hermes.example.test'],
    ['whitespace', ' https://hermes.example.test'],
    ['a newline', 'https://hermes.example.test\n'],
    ['a backslash', 'https://hermes.example.test\\@evil.example'],
    ['nothing', ''],
  ])('rejects %s (%j)', (_label, input) => {
    let error: unknown
    try {
      normalizeHermesOrigin(input)
    } catch (reason) {
      error = reason
    }
    expect(error).toBeInstanceOf(CindlError)
    expect((error as CindlError).code).toBe('invalid')
  })

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['https://hermes.example.test']])
      expect(() => normalizeHermesOrigin(value)).toThrow(CindlError)
  })

  it('trusts a stored origin only if it is still normalized and allowed', () => {
    expect(trustedStoredOrigin('https://hermes.example.test')).toBe(
      'https://hermes.example.test',
    )
    expect(trustedStoredOrigin('https://hermes.example.test/')).toBeUndefined()
    expect(trustedStoredOrigin('http://hermes.example.test')).toBeUndefined()
    expect(trustedStoredOrigin('https://owner:pw@hermes.example.test')).toBeUndefined()
    expect(trustedStoredOrigin(undefined)).toBeUndefined()
  })

  it('refuses before contacting anything', async () => {
    const opened = vi.fn(() => Promise.resolve())
    const { auth, fetch } = setup({ openBrowser: opened })
    await expect(auth.signIn('http://hermes.example.test')).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(opened).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('native sign-in against a fake hermes serve', () => {
  it('runs PKCE S256 through the loopback listener and keeps tokens out of the result', async () => {
    const { auth, secrets, kv } = setup()
    const session = await auth.signIn(`${hermes.origin}/`)
    expect(session).toEqual({
      origin: hermes.origin,
      provider: 'basic',
      userId: 'owner (synthetic)',
      expiresAt: expect.any(Number) as number,
    })
    expect(JSON.stringify(session)).not.toContain('synthetic-access')
    expect(hermes.requests).toEqual([
      'GET /auth/native/authorize',
      'POST /auth/native/token',
    ])
    // Only the normalized origin is stored; tokens only in the secret store.
    expect(kv.data.get(ORIGIN_KEY)).toBe(hermes.origin)
    expect([...kv.data.values()].join()).not.toContain('synthetic-')
    const stored = JSON.parse((await secrets.get(tokenKey(hermes.origin))) as string) as {
      access_token: string
    }
    expect(stored.access_token).toBe(hermes.issued.access[0])
    expect(hermes.bodies[0]).toEqual({
      code: expect.stringMatching(/^synthetic-code-/) as string,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/) as string,
    })
  })

  it('asks main to confirm the normalized origin and stops when declined', async () => {
    const opened = vi.fn(() => Promise.resolve())
    const confirmSignIn = vi.fn(() => Promise.resolve(false))
    const { auth, fetch } = setup({ openBrowser: opened, confirmSignIn })
    await expect(auth.signIn(`${hermes.origin}/`)).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(confirmSignIn).toHaveBeenCalledWith(hermes.origin)
    expect(opened).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(hermes.requests).toEqual([])
  })

  it('never logs codes, verifiers or tokens', async () => {
    const { auth } = setup()
    await auth.signIn(hermes.origin)
    await auth.accessToken()
    const logged = lines.join('\n')
    for (const secret of [
      ...hermes.issued.access,
      ...hermes.issued.refresh,
      String(hermes.bodies[0]?.code),
      String(hermes.bodies[0]?.code_verifier),
    ])
      expect(logged).not.toContain(secret)
  })

  it('ignores a forged callback and completes with the real one', async () => {
    const { auth } = setup({
      openBrowser: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri') as string)
        const forged = await fetch(
          `${redirect.href}?code=forged&state=forged-state-123456`,
        )
        expect(forged.status).toBe(400)
        await browserFollowsRedirect(url)
      },
    })
    await expect(auth.signIn(hermes.origin)).resolves.toMatchObject({
      origin: hermes.origin,
    })
    expect(hermes.bodies[0]?.code).not.toBe('forged')
  })

  it('reports a sign-in Hermes refused, without storing anything', async () => {
    hermes.denyNext()
    const { auth, kv } = setup()
    await expect(auth.signIn(hermes.origin)).rejects.toMatchObject({
      code: 'unauthenticated',
      detail: 'access_denied',
    })
    expect(kv.data.size).toBe(0)
    expect(hermes.requests).toEqual(['GET /auth/native/authorize'])
  })

  it('reports a rejected code exchange', async () => {
    hermes.failNext(400)
    const { auth, kv } = setup()
    await expect(auth.signIn(hermes.origin)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    expect(kv.data.size).toBe(0)
  })

  it('refreshes once for concurrent callers and stores the rotated tokens', async () => {
    hermes.setLifetime(30) // inside the refresh margin
    const { auth, secrets } = setup()
    await auth.signIn(hermes.origin)
    const [a, b, c] = await Promise.all([
      auth.accessToken(),
      auth.accessToken(),
      auth.accessToken(),
    ])
    expect(new Set([a, b, c]).size).toBe(1)
    expect(a).toBe(hermes.issued.access[1])
    expect(hermes.requests.filter((r) => r === 'POST /auth/native/refresh')).toHaveLength(
      1,
    )
    expect(hermes.bodies[1]).toEqual({
      refresh_token: hermes.issued.refresh[0],
      provider: 'basic',
    })
    const stored = JSON.parse((await secrets.get(tokenKey(hermes.origin))) as string) as {
      refresh_token: string
    }
    expect(stored.refresh_token).toBe(hermes.issued.refresh[1])
  })

  it('uses a fresh token without contacting Hermes', async () => {
    const { auth } = setup()
    await auth.signIn(hermes.origin)
    expect(await auth.accessToken()).toBe(hermes.issued.access[0])
    expect(hermes.requests).not.toContain('POST /auth/native/refresh')
  })

  it('forgets tokens when Hermes says the session expired', async () => {
    hermes.setLifetime(30)
    const { auth, secrets } = setup()
    await auth.signIn(hermes.origin)
    hermes.failNext(401)
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(await secrets.get(tokenKey(hermes.origin))).toBeUndefined()
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('keeps tokens when a refresh fails for another reason', async () => {
    hermes.setLifetime(30)
    const { auth, secrets } = setup()
    await auth.signIn(hermes.origin)
    hermes.failNext(503)
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'unavailable' })
    expect(await secrets.get(tokenKey(hermes.origin))).toBeDefined()
  })

  it('signs out locally without contacting Hermes', async () => {
    const { auth, secrets, kv, fetch } = setup()
    await auth.signIn(hermes.origin)
    const calls = fetch.mock.calls.length
    expect(await auth.signOut()).toEqual({ localOnly: true })
    expect(fetch.mock.calls.length).toBe(calls)
    expect(await secrets.get(tokenKey(hermes.origin))).toBeUndefined()
    expect(kv.data.get(ORIGIN_KEY)).toBe(hermes.origin)
    expect(await auth.session()).toBeUndefined()
  })

  it('does not let a refresh that was in flight undo a sign-out', async () => {
    hermes.setLifetime(30)
    const { auth, secrets } = setup()
    await auth.signIn(hermes.origin)
    const release = hermes.holdNextRefresh()
    const refreshing = auth.accessToken()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await auth.signOut()).toEqual({ localOnly: true })
    release()
    await expect(refreshing).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(await secrets.get(tokenKey(hermes.origin))).toBeUndefined()
    expect(await auth.session()).toBeUndefined()
  })

  it('ignores a token record moved under another origin', async () => {
    const { auth, kv, secrets } = setup()
    await auth.signIn(hermes.origin)
    const record = (await secrets.get(tokenKey(hermes.origin))) as string
    const other = 'https://hermes.example.test'
    await secrets.set(tokenKey(other), record)
    await kv.set(ORIGIN_KEY, other)
    expect(await auth.session()).toBeUndefined()
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('never sends a stored refresh token to an origin edited on disk', async () => {
    hermes.setLifetime(30)
    const { auth, kv, secrets, fetch } = setup()
    await auth.signIn(hermes.origin)
    const tokens = (await secrets.get(tokenKey(hermes.origin))) as string
    const tampered = 'http://hermes.example.test'
    await kv.set(ORIGIN_KEY, tampered)
    await secrets.set(tokenKey(tampered), tokens)
    const calls = fetch.mock.calls.length
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(fetch.mock.calls.length).toBe(calls)
    expect(await auth.origin()).toBeUndefined()
  })

  it('drops the previous origin’s tokens when signing in elsewhere', async () => {
    const other = await startFakeHermes()
    try {
      const { auth, secrets } = setup()
      await auth.signIn(hermes.origin)
      await auth.signIn(other.origin)
      expect(await secrets.get(tokenKey(hermes.origin))).toBeUndefined()
      expect(await secrets.get(tokenKey(other.origin))).toBeDefined()
    } finally {
      await other.close()
    }
  })

  it('writes nothing to disk when OS encryption is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindl-auth-'))
    try {
      const secrets = await createSecretStore({
        safeStorage: {
          isAsyncEncryptionAvailable: () => Promise.resolve(true),
          getSelectedStorageBackend: () => 'basic_text',
          encryptStringAsync: () => Promise.reject(new Error('must not be called')),
          decryptStringAsync: () => Promise.reject(new Error('must not be called')),
        },
        file: path.join(dir, 'secrets.json'),
        platform: 'linux',
      })
      const auth = createNativeAuth({
        fetch: globalThis.fetch,
        crypto: webCryptoProvider(),
        authorizer: createLoopbackAuthorizer({ openBrowser: browserFollowsRedirect }),
        secrets,
        kv: memoryKv(),
        confirmSignIn: () => Promise.resolve(true),
      })
      await auth.signIn(hermes.origin)
      expect(await auth.accessToken()).toBe(hermes.issued.access[0])
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('token expiry', () => {
  it('reads Unix seconds and keeps milliseconds', () => {
    expect(expiresAtMs(1_800_000_000)).toBe(1_800_000_000_000)
    expect(expiresAtMs(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(REFRESH_MARGIN_MS).toBeGreaterThan(0)
  })
})
