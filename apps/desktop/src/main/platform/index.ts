import {
  systemClock,
  type BinaryWebSocketFactory,
  type Clock,
  type KeyValueStore,
  type WebSocketFactory,
} from '@cindl/client-core'
import type { CindlEvent } from '@cindl/contracts'
import {
  restEndpoints,
  webCryptoProvider,
  type CryptoProvider,
  type FetchLike,
} from '@cindl/hermes-adapter'
import path from 'node:path'
import type { Logger } from '../log.ts'
import { createFileKeyValueStore } from './kv-store.ts'
import { createLoopbackAuthorizer, type LoopbackAuthorizerHandle } from './loopback.ts'
import { trustedStoredOrigin, usesSecureTransport } from './origin-policy.ts'
import {
  createSecretStore,
  type DesktopSecretStore,
  type SafeStorageLike,
} from './secret-store.ts'
import { createBinaryWebSocketFactory, createWebSocketFactory } from './websocket.ts'

/** Settings key for the Hermes origin this device signed in to (kept after sign-out). */
export const ORIGIN_KEY = 'hermes.origin'

/**
 * The only URL the sign-in flow may open in the system browser: the Hermes
 * native authorize endpoint, over https (or http on a loopback address),
 * without credentials.
 */
export function validateSignInUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (!usesSecureTransport(url) || url.protocol === 'wss:' || url.protocol === 'ws:')
      return undefined
    if (url.username !== '' || url.password !== '') return undefined
    if (url.pathname !== restEndpoints.nativeAuthorize.path) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Shown to the renderer when tokens cannot be persisted securely from the start. */
export function memoryOnlyNotice(reason: string | undefined): CindlEvent {
  return {
    type: 'notice',
    level: 'warning',
    message: `${reason ?? 'No OS keyring is available.'} After you sign in, Cindl keeps Hermes tokens in memory only and forgets them when it quits.`,
  }
}

/** Shown as soon as the keyring stops encrypting while Cindl runs. */
export function keyringRefusedNotice(reason: string | undefined): CindlEvent {
  return {
    type: 'notice',
    level: 'warning',
    message: `${reason ?? 'The OS keyring stopped encrypting.'} Until Cindl quits it keeps Hermes tokens in memory only and writes none to disk, so you will need to sign in again after a restart.`,
  }
}

/**
 * A fetch that only reaches the pinned Hermes origin: main never sends a
 * token, code or cookie anywhere else, whatever an URL from elsewhere says.
 */
export function pinnedFetch(
  fetch: FetchLike,
  origin: () => string | undefined,
): FetchLike {
  return (url, init) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return Promise.reject(new TypeError('Refused a request with an invalid URL'))
    }
    const allowed = origin()
    if (allowed === undefined || target.origin !== allowed)
      return Promise.reject(
        new TypeError('Refused a request outside the Hermes origin you confirmed'),
      )
    return fetch(url, init)
  }
}

/**
 * Everything the main-process Hermes client needs from Electron, built once
 * at startup and handed to `createDirectClient` (see session.ts). The
 * pinned origin is the stored one until you confirm another for sign-in;
 * fetch and both sockets only ever reach it.
 */
export interface DesktopPlatform {
  secrets: DesktopSecretStore
  kv: KeyValueStore
  authorizer: LoopbackAuthorizerHandle
  webSocket: WebSocketFactory
  /** The agent screen's RFB socket; its URL carries the display ticket. */
  displaySocket: BinaryWebSocketFactory
  crypto: CryptoProvider
  clock: Clock
  fetch: FetchLike
  /** The Hermes origin requests and sockets may reach. */
  origin(): string | undefined
  /** Allow `origin` (after the owner confirmed it for sign-in), or nothing. */
  pinOrigin(origin: string | undefined): void
}

export async function createDesktopPlatform(options: {
  safeStorage: SafeStorageLike
  userDataDir: string
  platform: NodeJS.Platform
  /** Electron `shell.openExternal`. */
  openExternal(url: string): Promise<void>
  log: Logger
  /** Defaults to Node's fetch. */
  fetch?: FetchLike
}): Promise<DesktopPlatform> {
  const { log } = options
  const secrets = await createSecretStore({
    safeStorage: options.safeStorage,
    file: path.join(options.userDataDir, 'secrets.json'),
    platform: options.platform,
    onWarning: log.warn,
  })
  const kv = createFileKeyValueStore(
    path.join(options.userDataDir, 'settings.json'),
    log.warn,
  )
  const authorizer = createLoopbackAuthorizer({
    openBrowser: async (url) => {
      const safe = validateSignInUrl(url)
      if (!safe) throw new Error('Refused to open an unexpected sign-in URL')
      await options.openExternal(safe)
    },
    log,
  })
  // A stored origin is used only if it still passes the contract's rule.
  let origin = trustedStoredOrigin(await kv.get(ORIGIN_KEY))
  const current = () => origin
  return {
    secrets,
    kv,
    authorizer,
    webSocket: createWebSocketFactory({ hermesOrigin: current }),
    displaySocket: createBinaryWebSocketFactory({ hermesOrigin: current }),
    crypto: webCryptoProvider(),
    clock: systemClock,
    fetch: pinnedFetch(options.fetch ?? ((url, init) => fetch(url, init)), current),
    origin: current,
    pinOrigin: (next) => {
      origin = trustedStoredOrigin(next)
    },
  }
}
