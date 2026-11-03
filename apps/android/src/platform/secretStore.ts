import type { SecretStore } from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'

/** The subset of expo-secure-store this app uses. */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

const PREFIX = 'cindl.s.'
/** Token sets are a few kilobytes; anything far larger is a bug, not a secret. */
export const MAX_SECRET_LENGTH = 64 * 1024

/**
 * expo-secure-store accepts keys made of [A-Za-z0-9._-] only, so client keys
 * (which may contain an origin such as `https://hermes.example.test`) are
 * hex-encoded. The encoding is injective: distinct keys never collide.
 */
export function secureStoreKey(key: string): string {
  let hex = ''
  for (const byte of new TextEncoder().encode(key))
    hex += byte.toString(16).padStart(2, '0')
  return PREFIX + hex
}

const PROBE_KEY = `${PREFIX}probe`
const PROBE_VALUE = 'cindl keystore probe'

/**
 * Whether this device's secure storage can keep secrets. expo-secure-store's
 * `isAvailableAsync()` only says its module exists (review of 636a2dd, S3), so
 * a canary value (not a secret) is written, read back and deleted: a Keystore
 * that cannot encrypt fails that, and the app starts in memory-only mode.
 */
export async function secureStoreAvailable(
  native: SecureStoreLike & { isAvailableAsync(): Promise<boolean> },
): Promise<boolean> {
  if (!(await native.isAvailableAsync())) return false
  try {
    await native.setItemAsync(PROBE_KEY, PROBE_VALUE)
    const read = await native.getItemAsync(PROBE_KEY)
    await native.deleteItemAsync(PROBE_KEY)
    return read === PROBE_VALUE
  } catch {
    await native.deleteItemAsync(PROBE_KEY).catch(() => undefined)
    return false
  }
}

/** The app's SecretStore, which can turn memory-only if the Keystore refuses a write. */
export interface AndroidSecretStore extends SecretStore {
  /** Called when a write failed and secrets stay in memory only from then on. */
  onDegraded(listener: () => void): () => void
}

/**
 * SecretStore on expo-secure-store: values are encrypted with an AES key held
 * in the Android Keystore and kept in app-private preferences. When the
 * device cannot encrypt (`available` false) nothing is stored at all; there
 * is no plaintext fallback. If the Keystore refuses a write later (it worked
 * at start), that value and any after it stay in memory only, `available`
 * turns false, and `onDegraded` listeners are told, so the app can say so
 * (desktop parity: apps/desktop/src/main/platform/secret-store.ts).
 */
export function createSecretStore(
  native: SecureStoreLike,
  available: boolean,
): AndroidSecretStore {
  // Values a refused write kept in memory instead.
  const memory = new Map<string, string>()
  let degraded = false
  const listeners = new Set<() => void>()
  return {
    get available() {
      return available && !degraded
    },
    async get(key) {
      const kept = memory.get(key)
      if (kept !== undefined) return kept
      if (!available) return undefined
      return (await native.getItemAsync(secureStoreKey(key))) ?? undefined
    },
    async set(key, value) {
      if (!available)
        throw new CindlError(
          'unavailable',
          'This device cannot encrypt secrets, so Cindl does not store any.',
        )
      if (value.length > MAX_SECRET_LENGTH)
        throw new CindlError('invalid', 'Secret value is unexpectedly large; not stored.')
      if (degraded) {
        memory.set(key, value)
        return
      }
      try {
        await native.setItemAsync(secureStoreKey(key), value)
      } catch {
        // The Keystore refused to encrypt: never fall back to plaintext on disk.
        degraded = true
        memory.set(key, value)
        for (const listener of [...listeners]) listener()
      }
    },
    async delete(key) {
      memory.delete(key)
      if (!available) return
      await native.deleteItemAsync(secureStoreKey(key))
    },
    onDegraded(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
