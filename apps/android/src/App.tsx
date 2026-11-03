import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi } from '@cindl/contracts'
import * as SplashScreen from 'expo-splash-screen'
import * as SystemUI from 'expo-system-ui'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { NavProvider } from './nav/NavProvider.tsx'
import { PortalHost } from './overlay/Portal.tsx'
import { resolveClient, type ClientResolution } from './platform/client.ts'
import type { AndroidClient } from './platform/direct.ts'
import { createPreferencesStore, type PreferencesStore } from './platform/preferences.ts'
import { PreferencesProvider, usePreference } from './platform/PreferencesProvider.tsx'
import { deviceKeyValueStore } from './platform/storage.ts'
import { AppShell } from './shell/AppShell.tsx'
import { ErrorBoundary } from './shell/ErrorBoundary.tsx'
import { KeyboardProvider } from './shell/keyboard.tsx'
import { SignInControlsProvider, type SignInControls } from './shell/signInControls.ts'
import { MotionProvider } from './theme/motion.tsx'
import { ThemeProvider, useTheme } from './theme/theme.tsx'

void SplashScreen.preventAutoHideAsync().catch(() => undefined)

interface Boot {
  preferences: PreferencesStore
  client: ClientResolution
}

async function boot(): Promise<Boot> {
  const preferences = createPreferencesStore(deviceKeyValueStore())
  await preferences.load()
  return { preferences, client: await resolveClient() }
}

function Themed({ children }: { children: ReactNode }) {
  const [preference] = usePreference('theme')
  return (
    <ThemeProvider preference={preference}>
      <RootBackground />
      {children}
    </ThemeProvider>
  )
}

/** Keeps the native root view (seen around the keyboard and during transitions) on canvas. */
function RootBackground() {
  const { colors } = useTheme()
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.canvas).catch(() => undefined)
  }, [colors.canvas])
  return null
}

export function App() {
  const [ready, setReady] = useState<Boot>()
  const [failed, setFailed] = useState<unknown>()
  useEffect(() => {
    let alive = true
    boot()
      .then(
        (result) => {
          if (alive) setReady(result)
        },
        (error: unknown) => {
          if (alive) setFailed(error)
        },
      )
      // Hide the splash once boot settles, whatever happens next, so an error screen is
      // never hidden behind it (ErrorBoundary also hides it when rendering fails).
      .finally(() => void SplashScreen.hideAsync().catch(() => undefined))
    return () => {
      alive = false
    }
  }, [])
  if (failed !== undefined)
    throw failed instanceof Error ? failed : new Error('Cindl could not start.')
  if (!ready) return null
  return (
    <SafeAreaProvider>
      <PreferencesProvider store={ready.preferences}>
        <Themed>
          <MotionProvider>
            <KeyboardProvider>
              {ready.client.kind === 'demo' ? (
                <Connected api={ready.client.api} />
              ) : (
                <Direct client={ready.client.client} />
              )}
            </KeyboardProvider>
          </MotionProvider>
        </Themed>
      </PreferencesProvider>
    </SafeAreaProvider>
  )
}

function Connected({ api, signIn }: { api: CindlClientApi; signIn?: SignInControls }) {
  return (
    <CindlProvider api={api}>
      <SignInControlsProvider value={signIn}>
        <NavProvider>
          <PortalHost>
            <AppShell />
          </PortalHost>
        </NavProvider>
      </SignInControlsProvider>
    </CindlProvider>
  )
}

/**
 * The real build. The client starts in this component's effect, which React
 * runs after CindlProvider's (a child's effects run first), so the store has
 * subscribed before the first link arrives.
 */
function Direct({ client }: { client: AndroidClient }) {
  useEffect(() => {
    void client.start()
    return () => client.stop()
  }, [client])
  const signIn = useMemo(() => ({ cancel: client.cancelSignIn }), [client])
  return <Connected api={client.api} signIn={signIn} />
}

export function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}
