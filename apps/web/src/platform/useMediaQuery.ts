import { useSyncExternalStore } from 'react'

/**
 * Live `matchMedia` result. Layout breakpoints are literal: 768 and 1280.
 * Where there is no `matchMedia` (jsdom), nothing matches.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  )
}
