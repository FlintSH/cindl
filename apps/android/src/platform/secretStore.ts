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

/**
 * SecretStore on expo-secure-store: values are encrypted with an AES key held
 * in the Android Keystore and kept in app-private preferences. When the
 * device cannot encrypt (`available` false) nothing is stored at all; there
 * is no plaintext fallback.
 */
export function createSecretStore(
  native: SecureStoreLike,
  available: boolean,
): SecretStore {
  return {
    available,
    async get(key) {
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
      await native.setItemAsync(secureStoreKey(key), value)
    },
    async delete(key) {
      if (!available) return
      await native.deleteItemAsync(secureStoreKey(key))
    },
  }
}
