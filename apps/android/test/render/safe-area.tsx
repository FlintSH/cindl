import type { ReactNode } from 'react'

// react-native-safe-area-context for rendered tests (vitest.config.ts alias): a
// phone without insets.
const none = { top: 0, right: 0, bottom: 0, left: 0 }

export const useSafeAreaInsets = () => none

export function SafeAreaProvider({ children }: { children: ReactNode }) {
  return children
}
