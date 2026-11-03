import { useCindlApi } from '@cindl/client-react'
import type { DisplayView } from '@cindl/contracts'
import { useEffect, useId, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { screenNative, ScreenSurfaceView } from '../../modules/cindl-screen/index.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, ErrorText, Note } from '../ui/primitives.tsx'
import { createScreenPainter, startScreenSession } from './screenSession.ts'

export const SCREEN_MODULE_MISSING =
  'This build cannot draw the screen: its screen module is missing.'

const nextPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })

/**
 * The agent-owned screen, live (ADR 0012; web parity:
 * apps/web/src/work/ScreenView.tsx). The client implementation holds the
 * Hermes ticket and speaks RFB; this paints the regions it returns into the
 * Kotlin picture (modules/cindl-screen). It never starts, stops or installs
 * the screen, and frames are never logged.
 */
export function ScreenView({ controlling }: { controlling: boolean }) {
  const api = useCindlApi()
  const theme = useTheme()
  const surface = `screen${useId()}`
  const [view, setView] = useState<DisplayView>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!screenNative) return
    const painter = createScreenPainter(screenNative, surface)
    const session = startScreenSession({
      call: (name, args) => api.call(name, args),
      paint: (frame) => painter.paint(frame),
      nextPaint,
      onView: setView,
      onError: setError,
    })
    return () => {
      session.stop()
      painter.release()
    }
  }, [api, surface, attempt])

  if (!screenNative || !ScreenSurfaceView)
    return <ErrorText>{SCREEN_MODULE_MISSING}</ErrorText>
  return (
    <View style={{ gap: theme.space[2] }}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={
          controlling
            ? 'The agent’s screen, live. You are in control.'
            : 'The agent’s screen, live. Watching.'
        }
        style={{
          width: '100%',
          aspectRatio: view ? view.width / view.height : 16 / 10,
          overflow: 'hidden',
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: theme.colors.borderStrong,
          backgroundColor: theme.colors.surfaceSunken,
        }}
      >
        <ScreenSurfaceView surface={surface} style={StyleSheet.absoluteFill} />
      </View>
      <Note>
        {controlling
          ? 'You are in control. Hermes pauses its own input while you hold the screen.'
          : 'Watching. Take control to use the pointer and keyboard.'}
      </Note>
      {error ? (
        <View style={{ gap: theme.space[2] }}>
          <ErrorText>{error}</ErrorText>
          <Button
            label="Try again"
            variant="quiet"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => {
              setError(undefined)
              setAttempt((value) => value + 1)
            }}
          />
        </View>
      ) : null}
    </View>
  )
}
