import {
  systemClock,
  type Clock,
  type KeyValueStore,
  type LoopbackAuthorizer,
  type SecretStore,
  type WebSocketFactory,
} from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'
import type { CryptoProvider, NativeTokenSet } from '@cindl/hermes-adapter'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { CryptoDigestAlgorithm, digest, getRandomBytes, randomUUID } from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { openBrowserAsync } from 'expo-web-browser'
import {
  loopbackNative,
  type CindlLoopbackNative,
} from '../../modules/cindl-loopback/index.ts'
import {
  cancelSignIn,
  createLoopbackAuthorizer,
  finishSignIn,
  recoverSignIn,
  signIn,
  type Recovery,
  type SignInAttempt,
  type SignInDeps,
} from '../auth/signIn.ts'
import { createTokenVault, type TokenVault } from '../auth/tokens.ts'
import { createCryptoProvider } from './crypto.ts'
import { createKeyValueStore } from './keyValueStore.ts'
import { createSecretStore } from './secretStore.ts'
import { createWebSocketFactory, type WebSocketConstructor } from './webSocket.ts'

/**
 * Everything the direct Hermes client needs on Android (the platform
 * interfaces in packages/client-core/src/platform.ts plus the native
 * sign-in). Real builds will call `createDirectClient(await
 * createAndroidPlatform())` once the transport lands; see
 * docs/handbook/clients/android.md.
 */
export interface AndroidPlatform {
  keyValue: KeyValueStore
  secrets: SecretStore
  webSocket: WebSocketFactory
  crypto: CryptoProvider
  /** client-core's loopback leg, for a direct client that runs PKCE itself. */
  loopback: LoopbackAuthorizer
  clock: Clock
  /** Full native sign-in with a persisted attempt (survives a JavaScript reload). */
  signIn: (origin: string) => Promise<{ origin: string; tokens: NativeTokenSet }>
  recoverSignIn: () => Promise<Recovery>
  resumeSignIn: (attempt: SignInAttempt) => Promise<NativeTokenSet>
  /** Stops the sign-in in progress; it then fails with "Sign-in was cancelled". */
  cancelSignIn: () => Promise<void>
  tokens: TokenVault
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
  const secrets = createSecretStore(SecureStore, await SecureStore.isAvailableAsync())
  const crypto = createCryptoProvider({
    getRandomBytes,
    digestSha256: (data) => digest(CryptoDigestAlgorithm.SHA256, data),
  })
  const deps: SignInDeps = {
    crypto,
    secrets,
    loopback: loopbackNative ?? missingListener,
    // Same task as Cindl, so closing the tab returns to the app.
    openBrowser: async (url) => {
      await openBrowserAsync(url, { createTask: false, showTitle: true })
    },
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    newAttemptId: () => randomUUID(),
  }
  return {
    keyValue: createKeyValueStore(AsyncStorage),
    secrets,
    // React Native's WebSocket (OkHttp) has the WebSocketLike shape; DOM typings differ only in `this`.
    webSocket: createWebSocketFactory(WebSocket as unknown as WebSocketConstructor),
    crypto,
    loopback: createLoopbackAuthorizer(deps),
    clock: systemClock,
    signIn: (origin) => signIn(origin, deps),
    recoverSignIn: () => recoverSignIn(deps),
    resumeSignIn: (attempt) => finishSignIn(attempt, deps),
    cancelSignIn: () => cancelSignIn(deps),
    tokens: createTokenVault(secrets),
  }
}
