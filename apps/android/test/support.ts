/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto'
import type {
  CindlLoopbackNative,
  LoopbackStatus,
} from '../modules/cindl-loopback/index.ts'
import { createCryptoProvider } from '../src/platform/crypto.ts'
import { createKeyValueStore } from '../src/platform/keyValueStore.ts'
import { createSecretStore } from '../src/platform/secretStore.ts'

/** Test double for the Kotlin listener (which has its own JUnit tests) plus the browser landing on it. */
export function fakeListener() {
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
  const cancelled: string[] = []
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
      cancelled.push(id)
      const attempt = attempts.get(id)
      if (attempt?.status === 'listening') fail(attempt, 'ERR_LOOPBACK_CANCELLED')
    },
  }
  return {
    native,
    attempts,
    cancelled,
    /** The browser landing on the loopback redirect: the same checks as the Kotlin listener. */
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

/**
 * expo-secure-store and AsyncStorage stand-ins, wrapped by the app's own stores.
 * `refuseWrites` makes the Keystore refuse to encrypt (as on a device whose
 * Keystore cannot), while `isAvailableAsync` still says true, as
 * expo-secure-store 58 does whenever its module exists.
 */
export function deviceStores(
  secretsAvailable = true,
  keystore: { refuseWrites?: () => boolean } = {},
) {
  const secure = new Map<string, string>()
  const async = new Map<string, string>()
  const native = {
    isAvailableAsync: () => Promise.resolve(true),
    getItemAsync: (key: string) => Promise.resolve(secure.get(key) ?? null),
    setItemAsync: (key: string, value: string) =>
      keystore.refuseWrites?.()
        ? Promise.reject(new Error('Could not encrypt the value (fixture Keystore).'))
        : Promise.resolve(void secure.set(key, value)),
    deleteItemAsync: (key: string) => Promise.resolve(void secure.delete(key)),
  }
  return {
    secure,
    async,
    native,
    secrets: createSecretStore(native, secretsAvailable),
    keyValue: createKeyValueStore({
      getItem: (key) => Promise.resolve(async.get(key) ?? null),
      setItem: (key, value) => Promise.resolve(void async.set(key, value)),
      removeItem: (key) => Promise.resolve(void async.delete(key)),
    }),
  }
}

/** The app's PKCE crypto provider over Node's crypto instead of expo-crypto. */
export const nodeCrypto = createCryptoProvider({
  getRandomBytes: (count) => new Uint8Array(randomBytes(count)),
  digestSha256: (data) => {
    const digest = createHash('sha256').update(data).digest()
    return Promise.resolve(
      digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength),
    )
  },
})
