/**
 * The real desktop wiring (platform/index.ts + session.ts) built as
 * src/main/index.ts builds it, minus Electron, for tests against the shared
 * fake `hermes serve` from @cindl/fixtures. Only the OS edges are simulated:
 * the keyring and the system browser, which follows Hermes's redirect to the
 * loopback listener. Nothing here contacts anything but 127.0.0.1.
 *
 * Each test file registers `afterEach(runCleanups)`.
 */
import { createStore, type ClientStore } from '@cindl/client-core'
import { CindlError, type CindlEvent, type LinkState } from '@cindl/contracts'
import {
  startFakeHermes,
  type FakeHermes,
  type FakeHermesOptions,
} from '@cindl/fixtures/fake-hermes'
import type { FetchLike } from '@cindl/hermes-adapter'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { createLogger, type Logger } from '../../src/main/log.ts'
import {
  createDesktopPlatform,
  type DesktopPlatform,
} from '../../src/main/platform/index.ts'
import type { SafeStorageLike } from '../../src/main/platform/secret-store.ts'
import { createRealClient, type RealClient } from '../../src/main/session.ts'

const cleanups: Array<() => Promise<void> | void> = []

export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

/**
 * An OS keyring stand-in: reversible, and never the plaintext. With
 * `refuse` set it refuses to encrypt (a keyring that locked), as Electron's
 * `encryptStringAsync` rejects; decryption keeps working.
 */
export function fakeKeyring(
  state: { refuse: boolean } = { refuse: false },
): SafeStorageLike {
  return {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: (plain) =>
      state.refuse
        ? Promise.reject(new Error('keyring locked (fixture)'))
        : Promise.resolve(
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
}

/** A working OS keyring. */
export const keyring = fakeKeyring()

/** No keyring at all (Electron's basic_text fallback is treated the same). */
export const noKeyring: SafeStorageLike = {
  ...keyring,
  isAsyncEncryptionAvailable: () => Promise.resolve(false),
}

/** The system browser: follow Hermes's authorize redirect to the loopback listener. */
export async function browser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  if (!location) throw new Error(`authorize answered ${authorize.status}`)
  await fetch(location)
}

export async function fakeHermes(options: FakeHermesOptions = {}): Promise<FakeHermes> {
  const fake = await startFakeHermes(options)
  cleanups.push(async () => {
    // Close first: a failed assertion must not leave the fake listening.
    await fake.close()
    expect(fake.violations, 'frames must match the vendored contract').toEqual([])
  })
  return fake
}

/** A loopback origin nothing listens on (an OS-assigned port, released again). */
export async function unreachableOrigin(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

export function userData(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindl-transport-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export interface Desktop {
  platform: DesktopPlatform
  real: RealClient
  store: ClientStore
  /** Every event the client emitted: what main forwards to the renderer. */
  events: CindlEvent[]
  log: Logger
  lines: string[]
  confirmSignIn: ReturnType<typeof vi.fn<(origin: string) => Promise<boolean>>>
  openBrowser: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  waitFor<T>(check: () => T | undefined | false, ms?: number): Promise<T>
  link(): LinkState
  secretEntries(): string[]
}

/** Build the app's real client exactly as src/main/index.ts does, minus Electron. */
export async function desktop(
  dir: string,
  options: {
    safeStorage?: SafeStorageLike
    confirm?: boolean
    fetch?: FetchLike
    /** Sees each screen socket URL main opens (it carries the display ticket). */
    onDisplaySocket?: (url: string) => void
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
  const { onDisplaySocket } = options
  if (onDisplaySocket) {
    const open = platform.displaySocket
    platform.displaySocket = (url) => {
      onDisplaySocket(url)
      return open(url)
    }
  }
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
    log,
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

export const signIn = async (d: Desktop, origin: string) => {
  await d.real.client.call('auth.signIn', { origin })
  await d.waitFor(() => d.link().phase === 'online')
}

export const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof CindlError ? error.code : String(error)),
  )
