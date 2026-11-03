import type { ThemeName } from '@cindl/tokens'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import {
  buildTheme,
  resolveThemeName,
  type CindlTheme,
  type ThemePreference,
} from './model.ts'

export type { CindlTheme, ThemePreference } from './model.ts'

const themes: Readonly<Record<ThemeName, CindlTheme>> = {
  light: buildTheme('light'),
  dark: buildTheme('dark'),
}

const ThemeContext = createContext<CindlTheme>(themes.light)

export function ThemeProvider({
  preference,
  children,
}: {
  preference: ThemePreference
  children: ReactNode
}) {
  const system = useColorScheme()
  const theme = themes[resolveThemeName(preference, system)]
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): CindlTheme {
  return useContext(ThemeContext)
}

/** Memoised style factory per theme. Pass a module-level function, not an inline one. */
export function useStyles<T>(factory: (theme: CindlTheme) => T): T {
  const theme = useTheme()
  return useMemo(() => factory(theme), [factory, theme])
}
