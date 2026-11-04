import { NativeAuth, nativeTokensKey, webCryptoProvider } from '@cindl/hermes-adapter'
import { systemClock } from '@cindl/client-core'
import { describe, expect, it } from 'vitest'
import {
  ATTEMPT_MARKER_KEY,
  createLoopbackAuthorizer,
  recoverInterruptedSignIn,
  SIGN_IN_TIMEOUT_MS,
} from '../src/auth/loopback.ts'
import {
  LEGACY_ATTEMPT_KEY,
  legacyTokensKey,
  migrateEarlierSignIn,
  ORIGIN_KEY,
} from '../src/auth/migrate.ts'
import { deviceStores, fakeListener } from './support.ts'

const ORIGIN = 'https://hermes.example.test'
const authorizeUrl = (redirectUri: string, state = 'state-1') =>
  `${ORIGIN}/auth/native/authorize?${new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
  }).toString()}`

function setup(
  browser: (url: string, listener: ReturnType<typeof fakeListener>) => void,
) {
  const listener = fakeListener()
  const stores = deviceStores()
  const opened: string[] = []
  let ids = 0
  const authorizer = createLoopbackAuthorizer({
    loopback: listener.native,
    keyValue: stores.keyValue,
    openBrowser: (url) => {
      opened.push(url)
      browser(url, listener)
      return Promise.resolve()
    },
    now: () => Date.parse('2026-06-02T08:00:00.000Z'),
    newAttemptId: () => `attempt-${++ids}`,
  })
  return { listener, stores, opened, authorizer }
}

/** The browser goes straight to the loopback redirect with a code and the URL's state. */
const approving = (url: string, listener: ReturnType<typeof fakeListener>) => {
  const params = new URL(url).searchParams
  const callback = new URL(params.get('redirect_uri') ?? '')
  callback.searchParams.set('code', 'code-1')
  callback.searchParams.set('state', params.get('state') ?? '')
  setTimeout(() => listener.deliver(callback.href), 0)
}

describe('the browser leg of sign-in (NativeAuth runs PKCE)', () => {
  it('opens the URL built for the listener and returns its callback', async () => {
    const { listener, opened, authorizer } = setup(approving)
    const callback = await authorizer.authorize((redirectUri) =>
      authorizeUrl(redirectUri),
    )
    expect(callback).toMatch(
      /^http:\/\/127\.0\.0\.1:41000\/callback\?code=code-1&state=state-1$/,
    )
    expect(new URL(opened[0] ?? '').searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:41000/callback',
    )
    expect(listener.attempts.get('attempt-1')?.state).toBe('state-1')
  })

  it('keeps a marker without secrets while the browser is open, and none after', async () => {
    let marker: string | undefined
    const { stores, authorizer } = setup((url, listener) => {
      void stores.keyValue.get(ATTEMPT_MARKER_KEY).then((value) => {
        marker = value
        approving(url, listener)
      })
    })
    await authorizer.authorize((redirectUri) => authorizeUrl(redirectUri))
    expect(JSON.parse(marker ?? '{}')).toEqual({
      v: 2,
      id: 'attempt-1',
      startedAt: Date.parse('2026-06-02T08:00:00.000Z'),
    })
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
  })

  it('stops waiting when cancelled, and saves nothing', async () => {
    const { listener, stores, authorizer } = setup(() => undefined)
    const waiting = authorizer.authorize((redirectUri) => authorizeUrl(redirectUri))
    await new Promise((resolve) => setTimeout(resolve, 0))
    authorizer.cancel()
    await expect(waiting).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'Sign-in was cancelled. Nothing was saved.',
    })
    expect(listener.native.status('attempt-1')).toBe('ended')
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
  })

  it('says when the browser did not come back in time', async () => {
    const { listener, authorizer } = setup(() => undefined)
    const waiting = authorizer.authorize((redirectUri) => authorizeUrl(redirectUri))
    await new Promise((resolve) => setTimeout(resolve, 0))
    listener.expire('attempt-1')
    await expect(waiting).rejects.toMatchObject({ code: 'timeout' })
    expect(SIGN_IN_TIMEOUT_MS).toBe(300_000)
  })

  it('refuses a URL without state and stops the listener', async () => {
    const { listener, opened, authorizer } = setup(approving)
    await expect(
      authorizer.authorize(
        (redirectUri) =>
          `${ORIGIN}/auth/native/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(opened).toEqual([])
    expect(listener.cancelled).toContain('attempt-1')
  })

  it('cleans up when the browser cannot be opened', async () => {
    const listener = fakeListener()
    const stores = deviceStores()
    const authorizer = createLoopbackAuthorizer({
      loopback: listener.native,
      keyValue: stores.keyValue,
      openBrowser: () => Promise.reject(new Error('no browser')),
      now: () => 0,
      newAttemptId: () => 'attempt-1',
    })
    await expect(
      authorizer.authorize((redirectUri) => authorizeUrl(redirectUri)),
    ).rejects.toThrow('no browser')
    expect(listener.native.status('attempt-1')).toBe('ended')
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
  })

  it('ends the wait of an earlier attempt when a new one starts', async () => {
    const { listener, authorizer } = setup(() => undefined)
    const first = authorizer.authorize((redirectUri) => authorizeUrl(redirectUri))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = authorizer.authorize((redirectUri) =>
      authorizeUrl(redirectUri, 'state-2'),
    )
    await expect(first).rejects.toMatchObject({ code: 'unauthenticated' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    listener.deliver('http://127.0.0.1:41001/callback?code=c&state=state-2')
    await expect(second).resolves.toMatch(/state=state-2$/)
  })
})

describe('a sign-in cancelled before its browser opens', () => {
  /** A gate a test opens: `arrived` once something waits on it. */
  function gate() {
    let arrive: () => void = () => undefined
    let open: () => void = () => undefined
    const arrived = new Promise<void>((resolve) => (arrive = resolve))
    const opened = new Promise<void>((resolve) => (open = resolve))
    return { arrived, open, wait: () => (arrive(), opened) }
  }
  /** The authorizer on the fakes, with the first marker write or listener start held. */
  function held(hold: 'marker' | 'start') {
    const listener = fakeListener()
    const stores = deviceStores()
    const at = gate()
    const markers: string[] = []
    let holding = true
    const opened: string[] = []
    let browserOpened: () => void = () => undefined
    const browser = new Promise<void>((resolve) => (browserOpened = resolve))
    let ids = 0
    const authorizer = createLoopbackAuthorizer({
      loopback: {
        ...listener.native,
        // Kotlin starts the listener on a background queue: a cancel() that
        // comes first finds no attempt of that id and is dropped
        // (CindlLoopbackModule.kt, LoopbackRegistry.cancel).
        start: async (id, timeout) => {
          if (hold === 'start' && holding) {
            holding = false
            await at.wait()
          }
          return listener.native.start(id, timeout)
        },
      },
      keyValue: {
        get: (key) => stores.keyValue.get(key),
        delete: (key) => stores.keyValue.delete(key),
        set: async (key, value) => {
          if (key === ATTEMPT_MARKER_KEY) {
            markers.push(value)
            if (hold === 'marker' && holding) {
              holding = false
              await at.wait()
            }
          }
          return stores.keyValue.set(key, value)
        },
      },
      openBrowser: (url) => {
        opened.push(url)
        browserOpened()
        return Promise.resolve()
      },
      now: () => 0,
      newAttemptId: () => `attempt-${++ids}`,
    })
    /** The attempt's outcome, or "browser opened" if the browser opens first. */
    const settle = (attempt: Promise<string>) =>
      Promise.race([
        attempt.then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        browser.then(() => 'browser opened'),
      ])
    return { listener, stores, at, markers, opened, authorizer, settle }
  }

  it('opens no browser when cancelled while its marker is written, and leaves nothing', async () => {
    const { listener, stores, at, markers, opened, authorizer, settle } = held('marker')
    const attempt = authorizer.authorize((redirectUri) => authorizeUrl(redirectUri))
    const outcome = settle(attempt)
    await at.arrived
    authorizer.cancel()
    at.open()
    expect(await outcome).toBe('Sign-in was cancelled. Nothing was saved.')
    await expect(attempt).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(opened).toEqual([])
    expect(markers).toHaveLength(1)
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
    expect(listener.cancelled).toContain('attempt-1')
    expect(listener.native.status('attempt-1')).toBe('ended')
  })

  it('opens no browser, and writes no marker, when cancelled while its listener starts', async () => {
    const { listener, stores, at, markers, opened, authorizer, settle } = held('start')
    const attempt = authorizer.authorize((redirectUri) => authorizeUrl(redirectUri))
    const outcome = settle(attempt)
    await at.arrived
    // The listener misses it: nothing of this attempt has started yet.
    authorizer.cancel()
    at.open()
    expect(await outcome).toBe('Sign-in was cancelled. Nothing was saved.')
    expect(opened).toEqual([])
    expect(markers).toEqual([])
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
    // It started after the cancel: stopped on the way out.
    expect(listener.native.status('attempt-1')).toBe('ended')
  })

  it('opens no browser for an attempt a newer one overtook while its marker was written', async () => {
    const { listener, at, opened, authorizer } = held('marker')
    const first = authorizer.authorize((redirectUri) => authorizeUrl(redirectUri))
    await at.arrived
    const second = authorizer.authorize((redirectUri) =>
      authorizeUrl(redirectUri, 'state-2'),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toHaveLength(1)
    at.open()
    await expect(first).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'Sign-in was cancelled. Nothing was saved.',
    })
    // Only the newer attempt's page opened, and its sign-in goes on.
    expect(opened.map((url) => new URL(url).searchParams.get('state'))).toEqual([
      'state-2',
    ])
    listener.deliver('http://127.0.0.1:41001/callback?code=c&state=state-2')
    await expect(second).resolves.toMatch(/state=state-2$/)
  })
})

describe('a sign-in interrupted by the app closing', () => {
  it('is found on the next start, its listener stopped and its marker removed', async () => {
    const listener = fakeListener()
    const stores = deviceStores()
    await stores.keyValue.set(
      ATTEMPT_MARKER_KEY,
      JSON.stringify({ v: 2, id: 'attempt-7', startedAt: 1 }),
    )
    expect(
      await recoverInterruptedSignIn({
        keyValue: stores.keyValue,
        loopback: listener.native,
      }),
    ).toBe(true)
    expect(listener.cancelled).toEqual(['attempt-7'])
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
    expect(
      await recoverInterruptedSignIn({
        keyValue: stores.keyValue,
        loopback: listener.native,
      }),
    ).toBe(false)
  })
})

describe('a sign-in made by an earlier build (its own PKCE)', () => {
  const tokens = {
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    token_type: 'bearer',
    expires_at: 1_900_000_000,
    provider: 'basic',
    user_id: 'synthetic-owner',
  }
  const nativeAuth = (secrets: ReturnType<typeof deviceStores>['secrets']) =>
    new NativeAuth({
      origin: ORIGIN,
      fetch: () => Promise.reject(new Error('no network in this test')),
      timers: systemClock,
      secrets,
      crypto: webCryptoProvider(),
    })

  it('moves its tokens to where NativeAuth reads them, once, and keeps the origin key', async () => {
    const { keyValue, secrets } = deviceStores()
    await keyValue.set(ORIGIN_KEY, ORIGIN)
    await secrets.set(legacyTokensKey(ORIGIN), JSON.stringify(tokens))
    await secrets.set(LEGACY_ATTEMPT_KEY, JSON.stringify({ v: 1, verifier: 'secret' }))
    expect(await migrateEarlierSignIn({ keyValue, secrets })).toEqual({
      origin: ORIGIN,
      interrupted: true,
    })
    expect(await secrets.get(legacyTokensKey(ORIGIN))).toBeUndefined()
    expect(await secrets.get(LEGACY_ATTEMPT_KEY)).toBeUndefined()
    expect(await secrets.get(nativeTokensKey(ORIGIN))).toBe(JSON.stringify(tokens))
    // Under the adapter's exported key, and its own class reads the moved record there.
    expect(await nativeAuth(secrets).identity()).toMatchObject({
      provider: 'basic',
      userId: 'synthetic-owner',
      persistent: true,
    })
    expect(await migrateEarlierSignIn({ keyValue, secrets })).toEqual({
      origin: ORIGIN,
      interrupted: false,
    })
  })

  it('drops an unreadable record and never replaces tokens NativeAuth already has', async () => {
    const { keyValue, secrets } = deviceStores()
    await keyValue.set(ORIGIN_KEY, ORIGIN)
    await secrets.set(legacyTokensKey(ORIGIN), '{"access_token":')
    await migrateEarlierSignIn({ keyValue, secrets })
    expect(await secrets.get(legacyTokensKey(ORIGIN))).toBeUndefined()
    expect(await secrets.get(nativeTokensKey(ORIGIN))).toBeUndefined()

    const current = { ...tokens, access_token: 'current' }
    await secrets.set(nativeTokensKey(ORIGIN), JSON.stringify(current))
    await secrets.set(legacyTokensKey(ORIGIN), JSON.stringify(tokens))
    await migrateEarlierSignIn({ keyValue, secrets })
    expect(await secrets.get(nativeTokensKey(ORIGIN))).toBe(JSON.stringify(current))
  })

  it('ignores a stored origin that is not a Hermes origin', async () => {
    const { keyValue, secrets } = deviceStores()
    await keyValue.set(ORIGIN_KEY, 'http://hermes.example.test')
    expect((await migrateEarlierSignIn({ keyValue, secrets })).origin).toBeUndefined()
  })
})
