import {
  systemClock,
  type BinaryWebSocketFactory,
  type Clock,
  type KeyValueStore,
  type SecretStore,
  type WebSocketFactory,
} from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'
import type { CryptoProvider, FetchLike } from '@cindl/hermes-adapter'
import { CryptoDigestAlgorithm, digest, getRandomBytes, randomUUID } from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { openBrowserAsync } from 'expo-web-browser'
import {
  loopbackNative,
  type CindlLoopbackNative,
} from '../../modules/cindl-loopback/index.ts'
import {
  createLoopbackAuthorizer,
  recoverInterruptedSignIn,
  type AndroidLoopbackAuthorizer,
} from '../auth/loopback.ts'
import { createCryptoProvider } from './crypto.ts'
import { guardFetch } from './origin.ts'
import {
  createBinaryWebSocketFactory,
  type RnWebSocketConstructor,
} from './screenSocket.ts'
import { createSecretStore } from './secretStore.ts'
import { deviceKeyValueStore } from './storage.ts'
import { createWebSocketFactory, type WebSocketConstructor } from './webSocket.ts'

/**
 * What the direct Hermes client (client-core `createDirectClient`) needs on
 * Android: the platform interfaces in packages/client-core/src/platform.ts
 * plus the browser leg of native sign-in. PKCE, tokens and refresh are the
 * adapter's NativeAuth, which the direct client runs.
 */
export interface AndroidPlatform {
  keyValue: KeyValueStore
  /** Keystore-backed; `available` false means tokens stay in memory only. */
  secrets: SecretStore
  webSocket: WebSocketFactory
  /** The agent screen's binary socket, only to `/api/display/ws` on the origin given. */
  screenSocket: (hermesOrigin: () => string | undefined) => BinaryWebSocketFactory
  fetch: FetchLike
  crypto: CryptoProvider
  clock: Clock
  /** The browser and loopback leg of sign-in, with a way to stop waiting. */
  authorizer: AndroidLoopbackAuthorizer
  /** On start: whether a sign-in from an earlier run was interrupted (and is now cleared). */
  recoverInterruptedSignIn: () => Promise<boolean>
}

const missingListener: CindlLoopbackNative = {
  start: () =>
    Promise.reject(
      new CindlError(
        'unsupported',
        'This build cannot sign in: its sign-in listener is missing.',
      ),
    ),
  arm: () => false,
  awaitCallback: () =>
    Promise.reject(new CindlError('unsupported', 'This build cannot sign in.')),
  status: () => 'unknown',
  cancel: () => undefined,
}

export async function createAndroidPlatform(): Promise<AndroidPlatform> {
  const keyValue = deviceKeyValueStore()
  const loopback = loopbackNative ?? missingListener
  const authorizer = createLoopbackAuthorizer({
    loopback,
    keyValue,
    // Same task as Cindl, so closing the tab returns to the app.
    openBrowser: async (url) => {
      await openBrowserAsync(url, { createTask: false, showTitle: true })
    },
    now: () => Date.now(),
    newAttemptId: () => randomUUID(),
  })
  return {
    keyValue,
    secrets: createSecretStore(SecureStore, await SecureStore.isAvailableAsync()),
    // React Native's WebSocket (OkHttp) has the WebSocketLike shape; DOM typings differ only in `this`.
    webSocket: createWebSocketFactory(WebSocket as unknown as WebSocketConstructor),
    screenSocket: (hermesOrigin) =>
      createBinaryWebSocketFactory({
        Socket: WebSocket as unknown as RnWebSocketConstructor,
        hermesOrigin,
      }),
    fetch: guardFetch((url, init) => fetch(url, init)),
    crypto: createCryptoProvider({
      getRandomBytes,
      digestSha256: (data) => digest(CryptoDigestAlgorithm.SHA256, data),
    }),
    clock: systemClock,
    authorizer,
    recoverInterruptedSignIn: () => recoverInterruptedSignIn({ keyValue, loopback }),
  }
}
