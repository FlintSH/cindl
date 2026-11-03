import {
  systemClock,
  type Clock,
  type KeyValueStore,
  type WebSocketFactory,
} from '@cindl/client-core'
import type { CindlEvent } from '@cindl/contracts'
import {
  restEndpoints,
  webCryptoProvider,
  type CryptoProvider,
} from '@cindl/hermes-adapter'
import path from 'node:path'
import type { Logger } from '../log.ts'
import { createFileKeyValueStore } from './kv-store.ts'
import { createLoopbackAuthorizer, type LoopbackAuthorizerHandle } from './loopback.ts'
import { createNativeAuth, ORIGIN_KEY, type NativeAuth } from './native-auth.ts'
import { trustedStoredOrigin, usesSecureTransport } from './origin-policy.ts'
import {
  createSecretStore,
  type DesktopSecretStore,
  type SafeStorageLike,
} from './secret-store.ts'
import { createWebSocketFactory } from './websocket.ts'

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

/** Shown to the renderer when tokens cannot be persisted securely. */
export function memoryOnlyNotice(reason: string | undefined): CindlEvent {
  return {
    type: 'notice',
    level: 'warning',
    message: `${reason ?? 'No OS keyring is available.'} After you sign in, Cindl keeps Hermes tokens in memory only and forgets them when it quits.`,
  }
}

/**
 * Everything the main-process Hermes client needs from Electron, built once
 * at startup. `createDirectClient` (client-core) takes these as its platform
 * dependencies; until it lands, the app uses `secrets`, `kv` and `auth` for
 * the signed-out state and local sign-out only.
 */
export interface DesktopPlatform {
  secrets: DesktopSecretStore
  kv: KeyValueStore
  authorizer: LoopbackAuthorizerHandle
  auth: NativeAuth
  webSocket: WebSocketFactory
  crypto: CryptoProvider
  clock: Clock
  fetch: typeof globalThis.fetch
  /** The Hermes origin this device last signed in to. */
  origin(): string | undefined
}

export async function createDesktopPlatform(options: {
  safeStorage: SafeStorageLike
  userDataDir: string
  platform: NodeJS.Platform
  /** Electron `shell.openExternal`. */
  openExternal(url: string): Promise<void>
  /** Native confirmation dialog for the origin, before any sign-in starts. */
  confirmSignIn: (origin: string) => Promise<boolean>
  log: Logger
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
  const crypto = webCryptoProvider()
  const fetch = globalThis.fetch.bind(globalThis)
  let origin = trustedStoredOrigin(await kv.get(ORIGIN_KEY))
  const auth = createNativeAuth({
    fetch,
    crypto,
    authorizer,
    secrets,
    kv,
    log,
    confirmSignIn: options.confirmSignIn,
    onSignedIn: (session) => {
      origin = session.origin
    },
  })
  return {
    secrets,
    kv,
    authorizer,
    auth,
    webSocket: createWebSocketFactory({ hermesOrigin: () => origin }),
    crypto,
    clock: systemClock,
    fetch,
    origin: () => origin,
  }
}
