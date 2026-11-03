import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Preferences, PreferencesStore } from './preferences.ts'

const PreferencesContext = createContext<PreferencesStore | null>(null)

export function PreferencesProvider({
  store,
  children,
}: {
  store: PreferencesStore
  children: ReactNode
}) {
  return (
    <PreferencesContext.Provider value={store}>{children}</PreferencesContext.Provider>
  )
}

export function usePreference<K extends keyof Preferences>(
  key: K,
): [Preferences[K], (value: Preferences[K]) => void] {
  const store = useContext(PreferencesContext)
  if (!store) throw new Error('usePreference must be used inside <PreferencesProvider>')
  const value = useSyncExternalStore(store.subscribe, () => store.get()[key])
  const set = useCallback((next: Preferences[K]) => store.set(key, next), [store, key])
  return [value, set]
}
