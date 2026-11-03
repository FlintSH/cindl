/// <reference types="node" />
import { randomUUID } from 'node:crypto'
import {
  createStore,
  entry,
  selectOpenRequests,
  systemClock,
  type ClientStore,
} from '@cindl/client-core'
import type { DisplayInputEvent, LinkState } from '@cindl/contracts'
import {
  nodeSocketFactory,
  startFakeHermes,
  type FakeHermes,
} from '@cindl/fixtures/fake-hermes'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATTEMPT_MARKER_KEY,
  createLoopbackAuthorizer,
  INTERRUPTED_NOTICE,
  recoverInterruptedSignIn,
} from '../src/auth/loopback.ts'
import {
  LEGACY_ATTEMPT_KEY,
  legacyTokensKey,
  nativeTokensKey,
  ORIGIN_KEY,
} from '../src/auth/migrate.ts'
import type { AndroidPlatform } from '../src/platform/android.ts'
import {
  createAndroidClient,
  MEMORY_ONLY_NOTICE,
  MEMORY_ONLY_NOW_NOTICE,
  type AndroidClient,
} from '../src/platform/direct.ts'
import { guardFetch } from '../src/platform/origin.ts'
import {
  createBinaryWebSocketFactory,
  type RnWebSocketConstructor,
} from '../src/platform/screenSocket.ts'
import {
  createSecretStore,
  secureStoreAvailable,
  secureStoreKey,
} from '../src/platform/secretStore.ts'
import {
  createWebSocketFactory,
  type WebSocketConstructor,
} from '../src/platform/webSocket.ts'
import { afterSignIn } from '../src/shell/afterSignIn.ts'
import { sendAnswer } from '../src/talk/requests.ts'
import { createGestures, createInputQueue, fitScreen } from '../src/work/screenInput.ts'
import { deviceStores, fakeListener, nodeCrypto } from './support.ts'

// The real Android client (src/platform/direct.ts) on the app's own platform pieces
// (Keystore secret store, AsyncStorage key-value store, the ticket-subprotocol WebSocket
// factory, the loopback authorizer), against the fixtures' fake `hermes serve` v0.22.5.
// Only expo-secure-store, AsyncStorage, the Kotlin listener and the browser are doubles.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fakeHermes(): Promise<FakeHermes> {
  const fake = await startFakeHermes()
  cleanups.push(async () => {
    expect(
      fake.violations,
      'fake Hermes frames must match the vendored contract',
    ).toEqual([])
    await fake.close()
  })
  return fake
}

/** React Native's WebSocket shape over the `ws` client the fake's tests use. */
const nodeSockets = nodeSocketFactory()
const NodeWebSocket = function (url: string, protocols: string[]) {
  return nodeSockets(url, protocols)
} as unknown as WebSocketConstructor

/** One device: its storage survives a restart (a new client on the same stores). */
function device(stores = deviceStores()) {
  const listener = fakeListener()
  const browser = { mode: 'approve' as 'approve' | 'hold', opened: [] as string[] }
  const platform: AndroidPlatform = {
    keyValue: stores.keyValue,
    secrets: stores.secrets,
    webSocket: createWebSocketFactory(NodeWebSocket),
    // Node's own WebSocket stands in for React Native's: same binaryType and events.
    screenSocket: (hermesOrigin) =>
      createBinaryWebSocketFactory({
        Socket: WebSocket as unknown as RnWebSocketConstructor,
        hermesOrigin,
      }),
    fetch: guardFetch((url, init) => fetch(url, init)),
    crypto: nodeCrypto,
    clock: systemClock,
    authorizer: createLoopbackAuthorizer({
      loopback: listener.native,
      keyValue: stores.keyValue,
      // The browser: Hermes's page signs the fixture owner in at once and redirects.
      openBrowser: async (url) => {
        browser.opened.push(url)
        if (browser.mode === 'hold') return
        const response = await fetch(url, { redirect: 'manual' })
        const location = response.headers.get('location')
        if (!location) throw new Error(`authorize failed with ${response.status}`)
        setTimeout(() => listener.deliver(location), 0)
      },
      now: () => Date.now(),
      newAttemptId: () => randomUUID(),
    }),
    recoverInterruptedSignIn: () =>
      recoverInterruptedSignIn({ keyValue: stores.keyValue, loopback: listener.native }),
  }
  return { stores, listener, browser, platform }
}

const unconfigured: LinkState = {
  phase: 'connecting',
  since: '2026-06-02T08:00:00.000Z',
  connectionEpoch: 0,
}

async function launch(
  platform: AndroidPlatform,
): Promise<{ client: AndroidClient; store: ClientStore }> {
  const client = await createAndroidClient(platform, {
    connection: { backoff: { initialMs: 20, maxMs: 100 } },
  })
  const store = createStore(unconfigured)
  client.api.subscribe((event) => store.dispatch(event))
  cleanups.push(() => client.stop())
  await client.start()
  return { client, store }
}

async function until<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  ms = 5_000,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() - started > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const calls = (fake: FakeHermes, name: string) =>
  fake.calls.filter((call) => call.name === name).length
const stored = (stores: ReturnType<typeof deviceStores>, key: string) =>
  stores.secure.get(secureStoreKey(key))

describe('the real Android client against a fake Hermes', () => {
  it('signs in once with the adapter PKCE through the loopback leg, and connects', async () => {
    const fake = await fakeHermes()
    const { stores, browser, platform } = device()
    const { client, store } = await launch(platform)
    expect(store.getState().link.phase).toBe('unconfigured')

    await client.api.call('auth.signIn', { origin: fake.origin })
    await until(() => store.getState().link.phase === 'online')
    expect(calls(fake, 'GET /auth/native/authorize')).toBe(1)
    expect(calls(fake, 'POST /auth/native/token')).toBe(1)
    const authorize = new URL(browser.opened[0] ?? '').searchParams
    expect(authorize.get('code_challenge_method')).toBe('S256')
    expect(authorize.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // Tokens only in the Keystore-backed store, where NativeAuth keeps them; the
    // origin (not a secret) under the device sign-in's key; no attempt marker left.
    expect(stored(stores, nativeTokensKey(fake.origin))).toMatch(/access_token/)
    expect(await stores.keyValue.get(ORIGIN_KEY)).toBe(fake.origin)
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
    expect([...stores.async.values()].join('\n')).not.toMatch(
      /access_token|refresh_token/,
    )
    // With the screen socket, the client negotiates the live picture itself.
    const view = await until(() => store.getState().capabilities['computer.view'])
    expect(view.state).toBe('available')
  })

  // Review of 636a2dd, S3: expo-secure-store's isAvailableAsync() is true whenever the
  // module exists, so the memory-only mode the handbook promises could never start.
  it('S3: on a device whose Keystore cannot encrypt, says tokens stay in memory, then signs in without an error or a stored token', async () => {
    const fake = await fakeHermes()
    const stores = deviceStores(true, { refuseWrites: () => true })
    const { platform } = device(stores)
    platform.secrets = createSecretStore(
      stores.native,
      await secureStoreAvailable(stores.native),
    )
    const { client, store } = await launch(platform)
    expect(platform.secrets.available).toBe(false)
    expect(store.getState().notices.map((n) => n.message)).toEqual([MEMORY_ONLY_NOTICE])
    await client.api.call('auth.signIn', { origin: fake.origin })
    await until(() => store.getState().link.phase === 'online')
    expect([...stores.secure.keys()]).toEqual([])
    expect([...stores.async.values()].join('\n')).not.toMatch(/access_token/)
  })

  it('S3: when the Keystore stops encrypting during sign-in, the sign-in finishes in memory only and says so', async () => {
    const fake = await fakeHermes()
    let refuse = false
    const stores = deviceStores(true, { refuseWrites: () => refuse })
    const { platform } = device(stores)
    platform.secrets = createSecretStore(
      stores.native,
      await secureStoreAvailable(stores.native),
    )
    const { client, store } = await launch(platform)
    expect(store.getState().notices).toEqual([])
    refuse = true
    // No raw Keystore error: the tokens stay in memory, and the owner is told.
    await client.api.call('auth.signIn', { origin: fake.origin })
    await until(() => store.getState().link.phase === 'online')
    expect(store.getState().notices.map((n) => n.message)).toEqual([
      MEMORY_ONLY_NOW_NOTICE,
    ])
    expect(platform.secrets.available).toBe(false)
    expect([...stores.secure.keys()]).toEqual([])
    client.stop()
    // Memory only: after a restart the sign-in is gone, and the start says why.
    const again = { ...platform }
    again.secrets = createSecretStore(
      stores.native,
      await secureStoreAvailable(stores.native),
    )
    const second = await launch(again)
    await until(() => second.store.getState().link.phase === 'signed-out')
    expect(second.store.getState().notices.map((n) => n.message)).toEqual([
      MEMORY_ONLY_NOTICE,
    ])
  })

  // Review of 636a2dd, N12: a sign-in whose connection never came up left the bare form.
  it('N12: after a sign-in whose connection does not come up, the sign-in screen says so and can be left', async () => {
    const fake = await fakeHermes()
    const { platform } = device()
    // /api/ws goes to a port nothing listens on; REST (the sign-in) still works.
    platform.webSocket = createWebSocketFactory(function (
      url: string,
      protocols: string[],
    ) {
      return nodeSockets(url.replace(/:\d+\//, ':9/'), protocols)
    } as unknown as WebSocketConstructor)
    const { client, store } = await launch(platform)
    await client.api.call('auth.signIn', { origin: fake.origin })
    const shown = await until(() => {
      const after = afterSignIn(true, store.getState().link)
      return after.kind === 'stuck' ? after : undefined
    })
    expect(shown.canContinue).toBe(true)
    expect(shown.message).toMatch(/^Signed in, but Cindl could not connect to Hermes/)
    expect(store.getState().link.phase).not.toBe('online')
  })

  it('is still signed in after a restart, without another sign-in', async () => {
    const fake = await fakeHermes()
    const { platform } = device()
    const first = await launch(platform)
    await first.client.api.call('auth.signIn', { origin: fake.origin })
    await until(() => first.store.getState().link.phase === 'online')
    first.client.stop()

    const second = await launch(platform)
    await until(() => second.store.getState().link.phase === 'online')
    expect(calls(fake, 'GET /auth/native/authorize')).toBe(1)
  })

  it("carries over an earlier build's sign-in and reports its unfinished attempt", async () => {
    const fake = await fakeHermes()
    const { stores, platform } = device()
    const session = fake.signIn()
    await stores.keyValue.set(ORIGIN_KEY, fake.origin)
    await stores.secrets.set(
      legacyTokensKey(fake.origin),
      JSON.stringify({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        token_type: 'bearer',
        expires_at: session.expiresAt,
        provider: session.provider,
        user_id: session.userId,
      }),
    )
    await stores.secrets.set(LEGACY_ATTEMPT_KEY, '{"v":1,"verifier":"synthetic"}')

    const { store } = await launch(platform)
    await until(() => store.getState().link.phase === 'online')
    expect(calls(fake, 'GET /auth/native/authorize')).toBe(0)
    expect(stored(stores, legacyTokensKey(fake.origin))).toBeUndefined()
    expect(stored(stores, LEGACY_ATTEMPT_KEY)).toBeUndefined()
    expect(store.getState().notices.map((n) => n.message)).toEqual([INTERRUPTED_NOTICE])
  })

  it('cancels a sign-in waiting for the browser: nothing exchanged, signed out', async () => {
    const fake = await fakeHermes()
    const { stores, browser, platform } = device()
    browser.mode = 'hold'
    const { client, store } = await launch(platform)
    const signingIn = client.api.call('auth.signIn', { origin: fake.origin })
    await until(() => browser.opened.length === 1)
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeDefined()
    client.cancelSignIn()
    await expect(signingIn).rejects.toMatchObject({
      message: 'Sign-in was cancelled. Nothing was saved.',
    })
    // The link says what is true, not "connecting".
    await until(() => store.getState().link.phase === 'signed-out')
    expect(calls(fake, 'POST /auth/native/token')).toBe(0)
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
    expect(await stores.keyValue.get(ORIGIN_KEY)).toBeUndefined()
  })

  it('reports a sign-in the app was closed during, on the next start', async () => {
    const { stores, listener, platform } = device()
    await stores.keyValue.set(
      ATTEMPT_MARKER_KEY,
      JSON.stringify({ v: 2, id: 'attempt-1', startedAt: Date.now() }),
    )
    const { store } = await launch(platform)
    expect(store.getState().notices.map((n) => n.message)).toEqual([INTERRUPTED_NOTICE])
    expect(listener.cancelled).toEqual(['attempt-1'])
    expect(await stores.keyValue.get(ATTEMPT_MARKER_KEY)).toBeUndefined()
  })

  it('answers an approval through Hermes and never a sudo prompt', async () => {
    const fake = await fakeHermes()
    const { platform } = device()
    const { client, store } = await launch(platform)
    await client.api.call('auth.signIn', { origin: fake.origin })
    await until(() => store.getState().link.phase === 'online')
    const conversation = await client.api.call('conversations.create', {
      title: 'Side (fixture)',
    })
    const sid = conversation.session.runtimeId ?? ''

    void fake.gateway.serverRequest(sid, 'sudo', { command: 'apt list (fixture)' })
    const sudo = await until(() =>
      selectOpenRequests(store.getState()).find((r) => r.kind === 'unsupported'),
    )
    await expect(
      sendAnswer(client.api, sudo, { kind: 'approval', choice: 'deny' }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(fake.calls.filter((c) => c.name === 'request.answer')).toEqual([])
    expect([...fake.gateway.open.values()].map((r) => r.method)).toEqual(['sudo'])

    const answered = fake.gateway.serverRequest(sid, 'approval', {
      request_id: 'd'.repeat(32),
      command: 'ls (fixture)',
    })
    const approval = await until(() =>
      selectOpenRequests(store.getState()).find((r) => r.kind === 'approval'),
    )
    await sendAnswer(client.api, approval, { kind: 'approval', choice: 'deny' })
    await expect(answered).resolves.toEqual({ choice: 'deny' })
    await until(
      () => entry(store.getState().requests, approval.requestId)?.status === 'answered',
    )
  })

  it('signs out on this device only: tokens gone, the origin kept to sign in again', async () => {
    const fake = await fakeHermes()
    const { stores, platform } = device()
    const { client, store } = await launch(platform)
    await client.api.call('auth.signIn', { origin: fake.origin })
    await until(() => store.getState().link.phase === 'online')
    await expect(client.api.call('auth.signOut', {})).resolves.toEqual({
      localOnly: true,
    })
    expect(store.getState().link.phase).toBe('signed-out')
    expect(stored(stores, nativeTokensKey(fake.origin))).toBeUndefined()
    expect(await stores.keyValue.get(ORIGIN_KEY)).toBe(fake.origin)
  })

  it('forgets the previous origin tokens when signing in to another Hermes', async () => {
    const first = await fakeHermes()
    const second = await fakeHermes()
    const { stores, platform } = device()
    const { client, store } = await launch(platform)
    await client.api.call('auth.signIn', { origin: first.origin })
    await until(() => store.getState().link.phase === 'online')
    await client.api.call('auth.signIn', { origin: second.origin })
    await until(
      () =>
        store.getState().link.phase === 'online' &&
        store.getState().link.server?.origin === second.origin,
    )
    expect(stored(stores, nativeTokensKey(first.origin))).toBeUndefined()
    expect(stored(stores, nativeTokensKey(second.origin))).toMatch(/access_token/)
    expect(await stores.keyValue.get(ORIGIN_KEY)).toBe(second.origin)
  })
})

describe('requests leave the app only for Hermes', () => {
  it('refuses plain http to anything but this device', async () => {
    const guarded = guardFetch(() => Promise.reject(new Error('should not be called')))
    await expect(
      guarded('http://hermes.example.test/api/status', {}),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('the agent screen through the real Android client', () => {
  const pixel = (
    regions: Array<{
      x: number
      y: number
      width: number
      height: number
      rgba: Uint8Array
    }>,
    x: number,
    y: number,
  ) => {
    for (const region of regions)
      if (
        x >= region.x &&
        y >= region.y &&
        x < region.x + region.width &&
        y < region.y + region.height
      ) {
        const at = ((y - region.y) * region.width + (x - region.x)) * 4
        return [...region.rgba.subarray(at, at + 3)]
      }
    return undefined
  }

  it('shows the picture, refuses input while watching and takes it in control', async () => {
    const fake = await fakeHermes()
    const { platform } = device()
    const { client, store } = await launch(platform)
    await client.api.call('auth.signIn', { origin: fake.origin })
    await until(
      () => store.getState().capabilities['computer.view']?.state === 'available',
    )

    const view = await client.api.call('display.watch', {})
    expect(view).toMatchObject({ width: 640, height: 400 })
    const first = await client.api.call('display.frame', { viewId: view.viewId })
    // The synthetic screen's desktop colour, painted through the app's own socket.
    expect(pixel(first.regions, 10, 40)).toEqual([47, 93, 98])

    // Watching: Hermes is never sent input.
    await expect(
      client.api.call('display.input', {
        viewId: view.viewId,
        events: [{ type: 'pointer', x: 100, y: 300, buttons: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })

    await client.api.call('display.acquireControl', { confirm: true })
    const sent = await client.api.call('display.input', {
      viewId: view.viewId,
      events: [
        { type: 'pointer', x: 100, y: 300, buttons: 1 },
        { type: 'pointer', x: 100, y: 300, buttons: 0 },
      ],
    })
    expect(sent.sent).toBe(2)
    // The synthetic screen draws its orange pointer marker where the tap landed.
    const marked = await until(async () => {
      const frame = await client.api.call('display.frame', { viewId: view.viewId })
      const colour = pixel(frame.regions, 100, 300)
      return colour && colour[0] === 230 ? colour : undefined
    })
    expect(marked).toEqual([230, 120, 40])
    await expect(
      client.api.call('display.unwatch', { viewId: view.viewId }),
    ).resolves.toEqual({
      stopped: true,
    })
  })

  it('turns a tap on the picture into a click only while in control', async () => {
    const fake = await fakeHermes()
    const { platform } = device()
    const { client, store } = await launch(platform)
    await client.api.call('auth.signIn', { origin: fake.origin })
    await until(
      () => store.getState().capabilities['computer.view']?.state === 'available',
    )
    const view = await client.api.call('display.watch', {})
    await client.api.call('display.frame', { viewId: view.viewId })

    const calls: DisplayInputEvent[][] = []
    const flushes: Array<() => void> = []
    const queue = createInputQueue({
      send: (events) => {
        calls.push(events)
        return client.api.call('display.input', { viewId: view.viewId, events })
      },
      schedule: (flush) => flushes.push(flush),
      onError: (error) => {
        throw error
      },
    })
    // The picture shown at twice its size: view (200, 600) is screen (100, 300).
    const gestures = createGestures({
      slop: 10,
      wheelStep: 24,
      fit: () => fitScreen(1280, 800, { width: view.width, height: view.height }),
    })
    const tap = () => {
      gestures.start([{ x: 200, y: 600 }])
      queue.push(gestures.end())
      flushes.shift()?.()
    }

    // Watching: the tap goes nowhere.
    tap()
    expect(calls).toEqual([])

    await client.api.call('display.acquireControl', { confirm: true })
    queue.setEnabled(true)
    tap()
    expect(calls).toEqual([
      [
        { type: 'pointer', x: 100, y: 300, buttons: 1 },
        { type: 'pointer', x: 100, y: 300, buttons: 0 },
      ],
    ])
    const marked = await until(async () => {
      const frame = await client.api.call('display.frame', { viewId: view.viewId })
      const colour = pixel(frame.regions, 100, 300)
      return colour && colour[0] === 230 ? colour : undefined
    })
    expect(marked).toEqual([230, 120, 40])
    await client.api.call('display.unwatch', { viewId: view.viewId })
  })
})
