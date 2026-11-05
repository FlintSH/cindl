import { useCallback, useSyncExternalStore } from 'react'

/**
 * Non-secret UI preferences in localStorage. Tokens are never stored in the
 * renderer: web relies on Hermes's HttpOnly cookie and desktop keeps them in
 * the main process (lint rule: no localStorage outside this module).
 */
export type ThemePreference = 'system' | 'light' | 'dark'

interface Preferences {
  theme: ThemePreference
  marginOpen: boolean
  /** The conversation list beside Talk on wide screens (Ctrl/⌘ B). */
  conversationsOpen: boolean
}

const KEY = 'cindl.preferences.v1'
const defaults: Preferences = {
  theme: 'system',
  marginOpen: true,
  conversationsOpen: true,
}
const listeners = new Set<() => void>()
let cache: Preferences | undefined

function read(): Preferences {
  if (cache) return cache
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(KEY) ?? '{}',
    ) as Partial<Preferences>
    cache = {
      theme:
        parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
      marginOpen: typeof parsed.marginOpen === 'boolean' ? parsed.marginOpen : true,
      conversationsOpen:
        typeof parsed.conversationsOpen === 'boolean' ? parsed.conversationsOpen : true,
    }
  } catch {
    cache = { ...defaults }
  }
  return cache
}

export function setPreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
) {
  cache = { ...read(), [key]: value }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    // Storage can be unavailable (private mode, quota). Preferences then last for the session.
  }
  for (const listener of listeners) listener()
}

export function usePreference<K extends keyof Preferences>(
  key: K,
): [Preferences[K], (value: Preferences[K]) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => read()[key],
  )
  const set = useCallback((next: Preferences[K]) => setPreference(key, next), [key])
  return [value, set]
}

export function applyTheme(theme: ThemePreference) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
