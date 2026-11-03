import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AccessibilityInfo } from 'react-native'

const ReducedMotionContext = createContext(false)

/**
 * Follows Android's "Remove animations" setting. When it is on, overlays
 * appear without movement and spinners stop (DESIGN.md: motion).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduced(value)
    })
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced,
    )
    return () => {
      alive = false
      subscription.remove()
    }
  }, [])
  return (
    <ReducedMotionContext.Provider value={reduced}>
      {children}
    </ReducedMotionContext.Provider>
  )
}

export function useReducedMotion(): boolean {
  return useContext(ReducedMotionContext)
}
