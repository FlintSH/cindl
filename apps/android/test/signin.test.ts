/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { base64Url, canonicalLoopbackRedirect } from '@cindl/hermes-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CindlLoopbackNative,
  LoopbackStatus,
} from '../modules/cindl-loopback/index.ts'
import {
  ATTEMPT_KEY,
  createLoopbackAuthorizer,
  finishSignIn,
  recoverSignIn,
  refreshTokens,
  signIn,
  SIGN_IN_TIMEOUT_MS,
  type SignInDeps,
} from '../src/auth/signIn.ts'
import {
  createTokenVault,
  expiresAtMs,
  needsRefresh,
  tokenKey,
} from '../src/auth/tokens.ts'
import { createCryptoProvider } from '../src/platform/crypto.ts'
import { createSecretStore, secureStoreKey } from '../src/platform/secretStore.ts'

/** A stand-in for hermes serve's native auth routes at v0.22.5 (see pkce.ts). */
async function fakeHermes() {
  const codes = new Map<string, { challenge: string; used: boolean }>()
  const refreshable = new Set<string>()
  let issued = 0
  const tokenSet = () => {
    issued += 1
    const refresh = `rt-${issued}-${randomBytes(6).toString('hex')}`
    refreshable.add(refresh)
    return {
      access_token: `at-${issued}`,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_at: 1_900_000_000,
      provider: 'basic',
      user_id: 'owner-fixture',
    }
  }
  const readJson = async (request: IncomingMessage) => {
    let text = ''
    for await (const chunk of request) text += String(chunk)
    return JSON.parse(text) as Record<string, string>
  }
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const send = (
        status: number,
        body: unknown,
        headers: Record<string, string> = {},
      ) =>
        response
          .writeHead(status, { 'content-type': 'application/json', ...headers })
          .end(JSON.stringify(body))
      if (request.method === 'GET' && url.pathname === '/auth/native/authorize') {
        const params = url.searchParams
        const state = params.get('state')
        const challenge = params.get('code_challenge')
        let redirect: string
        try {
          redirect = canonicalLoopbackRedirect(params.get('redirect_uri') ?? '')
        } catch {
          return send(400, { detail: 'invalid redirect_uri' })
        }
        if (params.get('code_challenge_method') !== 'S256' || !challenge || !state)
          return send(400, { detail: 'invalid request' })
        const code = `code-${randomBytes(8).toString('hex')}`
        codes.set(code, { challenge, used: false })
        const location = new URL(redirect)
        location.searchParams.set('code', code)
        location.searchParams.set('state', state)
        return send(302, {}, { location: location.href })
      }
      if (request.method === 'POST' && url.pathname === '/auth/native/token') {
        const body = await readJson(request)
        const entry = codes.get(body.code ?? '')
        const verified =
          entry !== undefined &&
          !entry.used &&
          base64Url(
            createHash('sha256')
              .update(body.code_verifier ?? '')
              .digest(),
          ) === entry.challenge
        if (entry) entry.used = true
        return verified ? send(200, tokenSet()) : send(400, { detail: 'invalid_grant' })
      }
      if (request.method === 'POST' && url.pathname === '/auth/native/refresh') {
        const body = await readJson(request)
        if (!refreshable.delete(body.refresh_token ?? ''))
          return send(401, { detail: 'session_expired' })
        return send(200, tokenSet())
      }
      return send(404, {})
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server, codes }
}

/** Test double for the Kotlin listener (which has its own JUnit tests) plus the browser. */
function fakeListener() {
  interface Attempt {
    port: number
    state?: string
    status: LoopbackStatus
    received?: string
    waiters: Array<{
      resolve: (target: string) => void
      reject: (error: unknown) => void
    }>
  }
  const attempts = new Map<string, Attempt>()
  let nextPort = 41_000
  const coded = (code: string) => Object.assign(new Error(code), { code })
  const fail = (attempt: Attempt, code: string) => {
    attempt.status = 'ended'
    for (const waiter of attempt.waiters.splice(0)) waiter.reject(coded(code))
  }
  const native: CindlLoopbackNative = {
    start: (id) => {
      const port = nextPort++
      attempts.set(id, { port, status: 'listening', waiters: [] })
      return Promise.resolve({ port })
    },
    arm: (id, state) => {
      const attempt = attempts.get(id)
      if (attempt?.status !== 'listening') return false
      attempt.state = state
      return true
    },
    awaitCallback: (id) =>
      new Promise<string>((resolve, reject) => {
        const attempt = attempts.get(id)
        if (!attempt) reject(coded('ERR_LOOPBACK_UNKNOWN_ATTEMPT'))
        else if (attempt.received !== undefined) resolve(attempt.received)
        else if (attempt.status === 'ended') reject(coded('ERR_LOOPBACK_CANCELLED'))
        else attempt.waiters.push({ resolve, reject })
      }),
    status: (id) => attempts.get(id)?.status ?? 'unknown',
    cancel: (id) => {
      const attempt = attempts.get(id)
      if (attempt?.status === 'listening') fail(attempt, 'ERR_LOOPBACK_CANCELLED')
    },
  }
  return {
    native,
    attempts,
    /** The browser landing on the loopback redirect: same checks as the Kotlin listener. */
    deliver(location: string) {
      const url = new URL(location)
      const attempt = [...attempts.values()].find((a) => a.port === Number(url.port))
      if (!attempt || attempt.status !== 'listening' || url.hostname !== '127.0.0.1')
        throw new Error('connection refused')
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== attempt.state)
        return 400
      const target = `${url.pathname}${url.search}`
      attempt.status = 'received'
      attempt.received = target
      for (const waiter of attempt.waiters.splice(0)) waiter.resolve(target)
      return 200
    },
    expire(id: string) {
      const attempt = attempts.get(id)
      if (attempt) fail(attempt, 'ERR_LOOPBACK_TIMEOUT')
    },
  }
}

function memorySecrets(available = true) {
  const data = new Map<string, string>()
  const native = {
    getItemAsync: (key: string) => Promise.resolve(data.get(key) ?? null),
    setItemAsync: (key: string, value: string) =>
      Promise.resolve(void data.set(key, value)),
    deleteItemAsync: (key: string) => Promise.resolve(void data.delete(key)),
  }
  return { data, store: createSecretStore(native, available) }
}

const crypto = createCryptoProvider({
  getRandomBytes: (count) => new Uint8Array(randomBytes(count)),
  digestSha256: (data) => {
    const digest = createHash('sha256').update(data).digest()
    return Promise.resolve(
      digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength),
    )
  },
})

describe('native sign-in against a fake Hermes server', () => {
  let hermes: Awaited<ReturnType<typeof fakeHermes>>
  let listener: ReturnType<typeof fakeListener>
  let secrets: ReturnType<typeof memorySecrets>
  let opened: string[]
  let deps: SignInDeps
  const now = Date.parse('2026-06-02T08:00:00.000Z')
  let ids = 0

  /** The owner signs in on Hermes's page; the browser follows the redirect to the loopback. */
  const browserSignsIn = async (url: string) => {
    opened.push(url)
    const response = await fetch(url, { redirect: 'manual' })
    const location = response.headers.get('location')
    if (!location) throw new Error(`authorize failed with ${response.status}`)
    setTimeout(() => listener.deliver(location), 0)
  }

  beforeEach(async () => {
    hermes = await fakeHermes()
    listener = fakeListener()
    secrets = memorySecrets()
    opened = []
    deps = {
      crypto,
      secrets: secrets.store,
      loopback: listener.native,
      openBrowser: browserSignsIn,
      fetch: (url, init) => fetch(url, init),
      now: () => now,
      newAttemptId: () => `attempt-${++ids}`,
    }
  })
  afterEach(() => new Promise<void>((resolve) => hermes.server.close(() => resolve())))

  it('signs in with PKCE S256 and a loopback redirect, then forgets the attempt', async () => {
    const { origin, tokens } = await signIn(`${hermes.origin}/`, deps)
    expect(origin).toBe(hermes.origin)
    expect(tokens).toMatchObject({ access_token: 'at-1', provider: 'basic' })
    const authorize = new URL(opened[0] ?? '')
    expect(authorize.pathname).toBe('/auth/native/authorize')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    )
    expect(secrets.data.has(secureStoreKey(ATTEMPT_KEY))).toBe(false)
    expect([...listener.attempts.values()].every((a) => a.status !== 'listening')).toBe(
      true,
    )
  })

  it('persists the verifier for the attempt only while the browser is open', async () => {
    let seenDuringBrowser: string | undefined
    deps.openBrowser = async (url) => {
      seenDuringBrowser = secrets.data.get(secureStoreKey(ATTEMPT_KEY))
      await browserSignsIn(url)
    }
    await signIn(hermes.origin, deps)
    const attempt = JSON.parse(seenDuringBrowser ?? '{}') as {
      verifier?: string
      origin?: string
    }
    expect(attempt.origin).toBe(hermes.origin)
    expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(secrets.data.size).toBe(0)
  })

  it.each([
    ['http://hermes.example.test', 'plain http'],
    ['https://owner:pw@hermes.example.test', 'credentials'],
    ['https://hermes.example.test/app', 'a path'],
    ['http://localhost:9119', 'localhost'],
  ])(
    'refuses %s (%s) before starting a listener or opening the browser',
    async (origin) => {
      await expect(signIn(origin, deps)).rejects.toMatchObject({ code: 'invalid' })
      expect(listener.attempts.size).toBe(0)
      expect(opened).toEqual([])
    },
  )

  it('refuses to start when the device cannot encrypt the sign-in', async () => {
    deps.secrets = memorySecrets(false).store
    await expect(signIn(hermes.origin, deps)).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(opened).toEqual([])
  })

  it('reports a provider error without saving anything', async () => {
    deps.openBrowser = (url) => {
      opened.push(url)
      const params = new URL(url).searchParams
      setTimeout(
        () =>
          listener.deliver(
            `${params.get('redirect_uri')}?error=access_denied&state=${params.get('state')}`,
          ),
        0,
      )
      return Promise.resolve()
    }
    await expect(signIn(hermes.origin, deps)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    expect(secrets.data.size).toBe(0)
  })

  it('a callback with the wrong state is refused and the attempt keeps waiting', async () => {
    deps.openBrowser = (url) => {
      const params = new URL(url).searchParams
      expect(
        listener.deliver(`${params.get('redirect_uri')}?code=forged&state=guess`),
      ).toBe(400)
      return browserSignsIn(url)
    }
    await expect(signIn(hermes.origin, deps)).resolves.toMatchObject({
      origin: hermes.origin,
    })
  })

  it('times out cleanly when the browser never returns', async () => {
    deps.openBrowser = (url) => {
      setTimeout(() => listener.expire('attempt-1'), 0)
      opened.push(url)
      return Promise.resolve()
    }
    ids = 0
    await expect(signIn(hermes.origin, deps)).rejects.toMatchObject({ code: 'timeout' })
    expect(secrets.data.size).toBe(0)
  })

  it('cleans up when the browser cannot be opened', async () => {
    deps.openBrowser = () => Promise.reject(new Error('No browser installed'))
    await expect(signIn(hermes.origin, deps)).rejects.toThrow('No browser installed')
    expect(secrets.data.size).toBe(0)
    expect([...listener.attempts.values()].every((a) => a.status === 'ended')).toBe(true)
  })

  it('the code is single use: a replayed exchange is rejected', async () => {
    let location = ''
    deps.openBrowser = async (url) => {
      const response = await fetch(url, { redirect: 'manual' })
      location = response.headers.get('location') ?? ''
      setTimeout(() => listener.deliver(location), 0)
    }
    await signIn(hermes.origin, deps)
    const code = new URL(location).searchParams.get('code') ?? ''
    const replay = await fetch(`${hermes.origin}/auth/native/token`, {
      method: 'POST',
      body: JSON.stringify({ code, code_verifier: 'x'.repeat(43) }),
    })
    expect(replay.status).toBe(400)
  })

  describe('after Android ends the process during sign-in', () => {
    const persisted = (startedAt: number) =>
      JSON.stringify({
        v: 1,
        id: 'attempt-old',
        origin: hermes.origin,
        verifier: 'v'.repeat(43),
        state: 's'.repeat(32),
        port: 41_999,
        startedAt,
      })

    it('reports the attempt as interrupted and wipes the verifier when no listener survived', async () => {
      await secrets.store.set(ATTEMPT_KEY, persisted(now))
      await expect(recoverSignIn(deps)).resolves.toEqual({
        kind: 'interrupted',
        origin: hermes.origin,
      })
      expect(secrets.data.size).toBe(0)
      await expect(recoverSignIn(deps)).resolves.toEqual({ kind: 'none' })
    })

    it('resumes an attempt whose listener is still alive in this process', async () => {
      let location = ''
      deps.openBrowser = async (url) => {
        location =
          (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? ''
        // The JavaScript runtime restarts while the browser is open: this call never returns.
        await new Promise(() => undefined)
      }
      void signIn(hermes.origin, deps)
      await vi.waitFor(() => expect(location).not.toBe(''))
      const recovery = await recoverSignIn(deps)
      expect(recovery.kind).toBe('resumable')
      if (recovery.kind !== 'resumable') return
      const finished = finishSignIn(recovery.attempt, deps)
      expect(listener.deliver(location)).toBe(200)
      await expect(finished).resolves.toMatchObject({ provider: 'basic' })
      expect(secrets.data.size).toBe(0)
    })

    it('treats an attempt older than the timeout as interrupted', async () => {
      await secrets.store.set(ATTEMPT_KEY, persisted(now - SIGN_IN_TIMEOUT_MS - 1))
      listener.attempts.set('attempt-old', {
        port: 41_999,
        status: 'listening',
        waiters: [],
      })
      await expect(recoverSignIn(deps)).resolves.toMatchObject({ kind: 'interrupted' })
      expect(listener.native.status('attempt-old')).toBe('ended')
    })

    it('wipes an unreadable attempt', async () => {
      await secrets.store.set(ATTEMPT_KEY, '{not json')
      await expect(recoverSignIn(deps)).resolves.toEqual({
        kind: 'interrupted',
        origin: undefined,
      })
      expect(secrets.data.size).toBe(0)
    })
  })

  it('keeps freshly issued tokens even if forgetting the attempt fails', async () => {
    const store = secrets.store
    deps.secrets = {
      available: store.available,
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: (key) =>
        key === ATTEMPT_KEY ? Promise.reject(new Error('disk')) : store.delete(key),
    }
    await expect(signIn(hermes.origin, deps)).resolves.toMatchObject({
      tokens: { provider: 'basic' },
    })
  })

  it("never deletes a newer attempt's recovery record", async () => {
    const newer = JSON.stringify({
      v: 1,
      id: 'attempt-newer',
      origin: hermes.origin,
      verifier: 'n'.repeat(43),
      state: 'n'.repeat(32),
      port: 41_500,
      startedAt: now,
    })
    deps.openBrowser = async (url) => {
      // A second attempt starts (and overwrites the record) before the first finishes.
      await secrets.store.set(ATTEMPT_KEY, newer)
      await browserSignsIn(url)
    }
    await signIn(hermes.origin, deps)
    expect(await secrets.store.get(ATTEMPT_KEY)).toBe(newer)
  })

  it('refreshes by rotating the refresh token; a used one is rejected', async () => {
    const { tokens } = await signIn(hermes.origin, deps)
    const rotated = await refreshTokens(hermes.origin, tokens, deps.fetch)
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
    await expect(refreshTokens(hermes.origin, tokens, deps.fetch)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })

  it('reports an unreachable server as offline', async () => {
    await expect(
      refreshTokens(
        'https://hermes.invalid',
        { refresh_token: 'x', provider: 'basic' },
        () => Promise.reject(new TypeError('fetch failed')),
      ),
    ).rejects.toMatchObject({ code: 'offline' })
  })

  it('serves client-core LoopbackAuthorizer with the state from the URL it builds', async () => {
    const authorizer = createLoopbackAuthorizer(deps)
    const callback = await authorizer.authorize((redirectUri) => {
      const url = new URL('/auth/native/authorize', hermes.origin)
      url.searchParams.set('code_challenge', 'c'.repeat(43))
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', 'state-from-url')
      return url.href
    })
    expect(new URL(callback).searchParams.get('state')).toBe('state-from-url')
    expect(new URL(callback).searchParams.get('code')).toMatch(/^code-/)
    await expect(
      authorizer.authorize(
        (redirectUri) =>
          `${hermes.origin}/auth/native/authorize?redirect_uri=${redirectUri}`,
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect([...listener.attempts.values()].every((a) => a.status !== 'listening')).toBe(
      true,
    )
  })
})

describe('token vault', () => {
  const tokens = {
    access_token: 'at',
    refresh_token: 'rt',
    token_type: 'bearer',
    expires_at: 1_900_000_000,
    provider: 'basic',
    user_id: 'owner-fixture',
  }

  it('keeps tokens only in the secret store, per origin', async () => {
    const { data, store } = memorySecrets()
    const vault = createTokenVault(store)
    await vault.write('https://hermes.example.test', tokens)
    expect([...data.keys()]).toEqual([
      secureStoreKey(tokenKey('https://hermes.example.test')),
    ])
    await expect(vault.read('https://hermes.example.test')).resolves.toEqual(tokens)
    await expect(vault.read('https://other.example.test')).resolves.toBeUndefined()
    await vault.clear('https://hermes.example.test')
    expect(data.size).toBe(0)
  })

  it('drops unreadable entries and refuses to store without encryption', async () => {
    const { data, store } = memorySecrets()
    await store.set(tokenKey('https://hermes.example.test'), '{"access_token": 1}')
    await expect(
      createTokenVault(store).read('https://hermes.example.test'),
    ).resolves.toBeUndefined()
    expect(data.size).toBe(0)
    await expect(
      createTokenVault(memorySecrets(false).store).write(
        'https://hermes.example.test',
        tokens,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reads expiry in seconds or milliseconds and refreshes a minute early', () => {
    expect(expiresAtMs({ expires_at: 1_900_000_000 })).toBe(1_900_000_000_000)
    expect(expiresAtMs({ expires_at: 1_900_000_000_000 })).toBe(1_900_000_000_000)
    expect(needsRefresh({ expires_at: 1_000 }, 1_000_000 - 60_001)).toBe(false)
    expect(needsRefresh({ expires_at: 1_000 }, 1_000_000 - 59_999)).toBe(true)
  })
})
