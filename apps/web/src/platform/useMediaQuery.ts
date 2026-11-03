import { useSyncExternalStore } from 'react'

/** Live `matchMedia` result. Layout breakpoints are literal: 768, 1024, 1280. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}
