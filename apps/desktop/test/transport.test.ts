/**
 * The real desktop wiring (platform/index.ts + session.ts) against the
 * shared fake `hermes serve` from @cindl/fixtures: the direct client, the
 * safeStorage secret store (with a fake keyring), the settings store, the
 * ticket-subprotocol WebSocket factory and the 127.0.0.1 loopback listener.
 * Only the OS edges are simulated: the keyring and the system browser,
 * which follows Hermes's redirect to the loopback listener. Nothing here
 * contacts anything but the fake on 127.0.0.1.
 */
import {
  createStore,
  entry,
  selectOpenRequests,
  type ClientStore,
} from '@cindl/client-core'
import {
  CindlError,
  type CindlEvent,
  type LinkState,
  type ServerRequest,
} from '@cindl/contracts'
import { startFakeHermes, type FakeHermes } from '@cindl/fixtures/fake-hermes'
import type { FetchLike } from '@cindl/hermes-adapter'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src/main/log.ts'
import {
  createDesktopPlatform,
  ORIGIN_KEY,
  type DesktopPlatform,
} from '../src/main/platform/index.ts'
import type { SafeStorageLike } from '../src/main/platform/secret-store.ts'
import { createRealClient, type RealClient } from '../src/main/session.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A working OS keyring stand-in: reversible, and never the plaintext. */
const keyring: SafeStorageLike = {
  isAsyncEncryptionAvailable: () => Promise.resolve(true),
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptStringAsync: (plain) =>
    Promise.resolve(
      Buffer.from(`enc:${Buffer.from(plain).reverse().toString('base64')}`),
    ),
  decryptStringAsync: (cipher) => {
    const text = cipher.toString()
    if (!text.startsWith('enc:')) return Promise.reject(new Error('not ours'))
    return Promise.resolve({
      result: Buffer.from(text.slice(4), 'base64').reverse().toString(),
      shouldReEncrypt: false,
    })
  },
}

/** No keyring at all (Electron's basic_text fallback is treated the same). */
const noKeyring: SafeStorageLike = {
  ...keyring,
  isAsyncEncryptionAvailable: () => Promise.resolve(false),
}

/** The system browser: follow Hermes's authorize redirect to the loopback listener. */
async function browser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  if (!location) throw new Error(`authorize answered ${authorize.status}`)
  await fetch(location)
}

async function fakeHermes(): Promise<FakeHermes> {
  const fake = await startFakeHermes()
  cleanups.push(async () => {
    expect(fake.violations, 'frames must match the vendored contract').toEqual([])
    await fake.close()
  })
  return fake
}

function userData(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindl-transport-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Desktop {
  platform: DesktopPlatform
  real: RealClient
  store: ClientStore
  /** Every event the client emitted: what main forwards to the renderer. */
  events: CindlEvent[]
  lines: string[]
  confirmSignIn: ReturnType<typeof vi.fn<(origin: string) => Promise<boolean>>>
  openBrowser: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  waitFor<T>(check: () => T | undefined | false, ms?: number): Promise<T>
  link(): LinkState
  secretEntries(): string[]
}

/** Build the app's real client exactly as src/main/index.ts does, minus Electron. */
async function desktop(
  dir: string,
  options: {
    safeStorage?: SafeStorageLike
    confirm?: boolean
    fetch?: FetchLike
  } = {},
): Promise<Desktop> {
  const lines: string[] = []
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) })
  const openBrowser = vi.fn(browser)
  const platform = await createDesktopPlatform({
    safeStorage: options.safeStorage ?? keyring,
    userDataDir: dir,
    platform: 'linux',
    openExternal: openBrowser,
    log,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const confirmSignIn = vi.fn(() => Promise.resolve(options.confirm ?? true))
  const real = createRealClient(platform, {
    confirmSignIn,
    log,
    connection: { backoff: { initialMs: 20, maxMs: 100 } },
  })
  const store = createStore({
    phase: 'connecting',
    since: '2026-06-02T08:00:00.000Z',
    connectionEpoch: 0,
  })
  const events: CindlEvent[] = []
  real.client.subscribe((event) => {
    events.push(event)
    store.dispatch(event)
  })
  cleanups.push(() => {
    real.stop()
    platform.authorizer.cancel()
  })
  await real.start()
  const waitFor = async <T>(check: () => T | undefined | false, ms = 8_000) => {
    const started = Date.now()
    for (;;) {
      const value = check()
      if (value !== undefined && value !== false) return value
      if (Date.now() - started > ms) throw new Error('condition not met in time')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const secretsFile = path.join(dir, 'secrets.json')
  return {
    platform,
    real,
    store,
    events,
    lines,
    confirmSignIn,
    openBrowser,
    waitFor,
    link: () => store.getState().link,
    secretEntries: () =>
      existsSync(secretsFile)
        ? Object.keys(
            (JSON.parse(readFileSync(secretsFile, 'utf8')) as { entries: object })
              .entries,
          )
        : [],
  }
}

const signIn = async (d: Desktop, origin: string) => {
  await d.real.client.call('auth.signIn', { origin })
  await d.waitFor(() => d.link().phase === 'online')
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof CindlError ? error.code : String(error)),
  )

describe('desktop wiring against a fake hermes serve', { timeout: 30_000 }, () => {
  it('signs in through the loopback leg, connects, answers an approval and signs out locally', async () => {
    const fake = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    expect(d.link().phase).toBe('unconfigured')

    await signIn(d, `${fake.origin}/`)
    // Main asked first, with the normalized origin; the browser leg went to Hermes.
    expect(d.confirmSignIn).toHaveBeenCalledWith(fake.origin)
    expect(d.openBrowser).toHaveBeenCalledTimes(1)
    expect(new URL(d.openBrowser.mock.calls[0]?.[0] ?? '').pathname).toBe(
      '/auth/native/authorize',
    )
    expect(d.link()).toMatchObject({ phase: 'online', auth: 'native-pkce' })
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        { kind: 'rest', name: 'POST /auth/native/token' },
        { kind: 'ws', name: '/api/ws' },
      ]),
    )
    // Tokens are in the encrypted store under this origin, and the origin is remembered.
    expect(d.secretEntries()).toEqual([expect.stringContaining(fake.origin)])
    expect(readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toMatch(
      /access_token|refresh_token/,
    )
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(fake.origin)

    const listed = await d.real.client.call('conversations.list', {})
    expect(Array.isArray(listed)).toBe(true)
    expect(fake.calls).toContainEqual({ kind: 'rpc', name: 'session.list' })

    const outcome: { result?: unknown } = {}
    fake.gateway.script = async (turn) => {
      outcome.result = await turn.approval({ choices: ['once', 'deny'] })
    }
    const conversation = await d.real.client.call('conversations.create', {
      title: 'Kiln check (fixture)',
    })
    await d.real.client.call('prompt.submit', {
      conversationId: conversation.id,
      clientId: 'transport-test-1',
      text: 'export it',
    })
    const request = await d.waitFor(() =>
      selectOpenRequests(d.store.getState()).find(
        (r) => r.conversationId === conversation.id && r.kind === 'approval',
      ),
    )
    const answered = await d.real.client.call('request.answer', {
      requestId: request.requestId,
      answer: { kind: 'approval', choice: 'once' },
    })
    expect(answered.status).toBe('answered')
    await d.waitFor(
      () => entry(d.store.getState().requests, request.requestId)?.status === 'answered',
    )
    await d.waitFor(() => outcome.result)

    expect(await d.real.client.call('auth.signOut', {})).toEqual({ localOnly: true })
    expect(d.link().phase).toBe('signed-out')
    // Tokens are gone from disk; the origin is kept for the next sign-in.
    expect(d.secretEntries()).toEqual([])
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(fake.origin)
    const again = await desktop(dir)
    await again.waitFor(() => again.link().phase === 'signed-out')
    expect(again.link().server?.origin).toBe(fake.origin)
  })

  it('announces where it starts once: unconfigured, with its capabilities', async () => {
    const d = await desktop(userData())
    const links = d.events.flatMap((event) =>
      event.type === 'link.changed' ? [event.link.phase] : [],
    )
    expect(links).toEqual(['unconfigured'])
    expect(
      d.events.filter((event) => event.type === 'capabilities.changed'),
    ).toHaveLength(1)
  })

  it('never answers a sudo prompt', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, fake.origin)
    const conversation = await d.real.client.call('conversations.create', {
      title: 'Sudo check (fixture)',
    })
    void fake.gateway.serverRequest(conversation.session.runtimeId ?? '', 'sudo', {
      command: 'apt list (fixture)',
    })
    const request: ServerRequest = await d.waitFor(() =>
      selectOpenRequests(d.store.getState()).find(
        (r) => r.conversationId === conversation.id,
      ),
    )
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'sudo' })
    expect(
      await codeOf(
        d.real.client.call('request.answer', {
          requestId: request.requestId,
          answer: { kind: 'approval', choice: 'deny' },
        }),
      ),
    ).toBe('unsupported')
    // No reply of any kind reached Hermes: the prompt is still open there.
    expect(
      fake.calls.filter((c) => c.kind === 'rpc' && c.name === 'request.answer'),
    ).toEqual([])
    expect([...fake.gateway.open.values()].map((r) => r.method)).toEqual(['sudo'])
    expect(fake.gateway.settled).toEqual([])
  })

  it('sends nothing until main confirms the origin', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData(), { confirm: false })
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: fake.origin }))).toBe(
      'forbidden',
    )
    expect(d.confirmSignIn).toHaveBeenCalledWith(fake.origin)
    expect(d.openBrowser).not.toHaveBeenCalled()
    expect(fake.calls).toEqual([])
    expect(d.platform.origin()).toBeUndefined()
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBeUndefined()
  })

  it('refuses a second sign-in while one waits for confirmation', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData())
    let release: (answer: boolean) => void = () => undefined
    d.confirmSignIn.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    )
    const first = d.real.client.call('auth.signIn', { origin: fake.origin })
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: fake.origin }))).toBe(
      'unavailable',
    )
    release(false)
    expect(await codeOf(first)).toBe('forbidden')
  })

  it('never logs codes, verifiers or tokens', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, fake.origin)
    await d.real.client.call('conversations.list', {})
    const [key] = d.secretEntries()
    const tokens = JSON.parse(
      (await d.platform.secrets.get(key ?? '')) ?? '{}',
    ) as Record<string, unknown>
    const secrets = [tokens.access_token, tokens.refresh_token].filter(
      (value): value is string => typeof value === 'string',
    )
    expect(secrets).toHaveLength(2)
    const logged = d.lines.join('\n')
    for (const secret of secrets) expect(logged).not.toContain(secret)
    expect(logged).not.toMatch(/code_verifier=|[?&]code=[^[]/)
  })

  it('does not let a refresh that was in flight undo a sign-out', async () => {
    const fake = await fakeHermes()
    // Short-lived access tokens: every authenticated call refreshes first.
    fake.auth.accessTtlSeconds = 30
    const gate: {
      hold: boolean
      held: boolean
      reached?: () => void
      release?: () => void
    } = { hold: false, held: false }
    const reached = new Promise<void>((resolve) => (gate.reached = resolve))
    const held = new Promise<void>((resolve) => (gate.release = resolve))
    const fetchWithGate: FetchLike = async (url, init) => {
      if (gate.hold && new URL(url).pathname === '/auth/native/refresh') {
        gate.held = true
        gate.reached?.()
        await held
      }
      return fetch(url, init)
    }
    const dir = userData()
    const d = await desktop(dir, { fetch: fetchWithGate })
    await signIn(d, fake.origin)
    gate.hold = true
    // A call may reuse a refresh that was already in flight; the next one starts its own.
    const pending: Array<Promise<unknown>> = []
    for (let attempt = 0; attempt < 20 && !gate.held; attempt++) {
      pending.push(d.real.client.call('skills.list', {}).catch(() => undefined))
      await Promise.race([reached, new Promise((resolve) => setTimeout(resolve, 100))])
    }
    expect(gate.held).toBe(true)
    expect(await d.real.client.call('auth.signOut', {})).toEqual({ localOnly: true })
    gate.release?.()
    await Promise.all(pending)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(d.secretEntries()).toEqual([])
    const again = await desktop(dir)
    await again.waitFor(() => again.link().phase === 'signed-out')
  })

  it('does not use a token record copied under another origin', async () => {
    const first = await fakeHermes()
    const second = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    await signIn(d, first.origin)
    d.real.stop()
    // Same-user tampering: move the encrypted record and the stored origin.
    const file = path.join(dir, 'secrets.json')
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      entries: Record<string, string>
    }
    const [key] = Object.keys(data.entries)
    const moved = (key ?? '').replace(first.origin, second.origin)
    data.entries = { [moved]: data.entries[key ?? ''] ?? '' }
    writeFileSync(file, JSON.stringify(data))
    await d.platform.kv.set(ORIGIN_KEY, second.origin)
    const tampered = await desktop(dir)
    await tampered.waitFor(() => tampered.link().phase === 'signed-out')
    // The copied record never decrypted for the second origin: it received no
    // authenticated request at all, only the public status probe.
    expect(second.calls.filter((c) => c.name !== 'GET /api/status')).toEqual([])
  })

  it('forgets the previous origin’s tokens after signing in elsewhere', async () => {
    const first = await fakeHermes()
    const second = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    await signIn(d, first.origin)
    await signIn(d, second.origin)
    expect(d.secretEntries()).toEqual([expect.stringContaining(second.origin)])
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(second.origin)
  })

  it('keeps tokens in memory only, and says so, without a keyring', async () => {
    const fake = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir, { safeStorage: noKeyring })
    expect(d.real.notices()).toEqual([
      expect.objectContaining({ type: 'notice', level: 'warning' }),
    ])
    await signIn(d, fake.origin)
    await d.real.client.call('conversations.list', {})
    expect(existsSync(path.join(dir, 'secrets.json'))).toBe(false)
    // A restart has nothing to sign in with.
    d.real.stop()
    const again = await desktop(dir, { safeStorage: noKeyring })
    await again.waitFor(() => again.link().phase === 'signed-out')
  })
})
