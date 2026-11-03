import type { KeyValueStore } from '@cindl/client-core'
import type { ThemePreference } from '../theme/model.ts'

/** Non-secret UI preferences for this device. Tokens never live here. */
export interface Preferences {
  theme: ThemePreference
}

export const defaultPreferences: Preferences = { theme: 'system' }
const KEY = 'preferences.v1'

export function parsePreferences(raw: string | undefined): Preferences {
  if (!raw) return defaultPreferences
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof Preferences, unknown>>
    const theme = parsed.theme
    return {
      theme:
        theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
    }
  } catch {
    return defaultPreferences
  }
}

/** Property signatures: every member is safe to pass around unbound. */
export interface PreferencesStore {
  load: () => Promise<void>
  get: () => Preferences
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void
  subscribe: (listener: () => void) => () => void
}

/**
 * Preferences change in memory first (the UI updates at once) and are then
 * written to the key-value store. A failed write keeps the in-memory value
 * for this session; it never blocks the UI.
 */
export function createPreferencesStore(store: KeyValueStore): PreferencesStore {
  let current = defaultPreferences
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    async load() {
      try {
        current = parsePreferences(await store.get(KEY))
      } catch {
        current = defaultPreferences
      }
      notify()
    },
    get: () => current,
    set(key, value) {
      current = { ...current, [key]: value }
      notify()
      void store.set(KEY, JSON.stringify(current)).catch(() => undefined)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
