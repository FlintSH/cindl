import type { KeyValueStore } from '@cindl/client-core'

/** The subset of @react-native-async-storage/async-storage this app uses. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/**
 * Non-secret persistence (preferences, outbox, answered-request ledger) in
 * AsyncStorage, which is app-private storage excluded from backups
 * (allowBackup=false). Tokens never go here: use the SecretStore.
 */
export function createKeyValueStore(
  storage: AsyncStorageLike,
  namespace = 'cindl.kv.',
): KeyValueStore {
  return {
    get: async (key) => (await storage.getItem(namespace + key)) ?? undefined,
    set: (key, value) => storage.setItem(namespace + key, value),
    delete: (key) => storage.removeItem(namespace + key),
  }
}
