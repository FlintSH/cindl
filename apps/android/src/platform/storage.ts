import type { KeyValueStore } from '@cindl/client-core'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createKeyValueStore } from './keyValueStore.ts'

/**
 * This device's non-secret key-value store: AsyncStorage, app-private and
 * excluded from backups. The one module that opens it; secrets go to the
 * Keystore-backed SecretStore (secretStore.ts).
 */
export function deviceKeyValueStore(): KeyValueStore {
  return createKeyValueStore(AsyncStorage)
}
