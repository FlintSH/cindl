import { useCindlApi } from '@cindl/client-react'
import { isCindlError, type DisplayInputEvent, type DisplayView } from '@cindl/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import {
  StyleSheet,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type TextInputInstance,
} from 'react-native'
import { screenNative, ScreenSurfaceView } from '../../modules/cindl-screen/index.ts'
import { useTheme } from '../theme/theme.tsx'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard } from '../ui/icons.ts'
import { Button, ErrorText, Note } from '../ui/primitives.tsx'
import {
  createGestures,
  createInputQueue,
  fitScreen,
  keyPress,
  textToKeys,
  type TouchPoint,
} from './screenInput.ts'
import {
  createScreenPainter,
  screenSurfaceId,
  startScreenSession,
} from './screenSession.ts'

export const SCREEN_MODULE_MISSING =
  'This build cannot draw the screen: its screen module is missing.'

/** Android's long-press time, and finger travel (dp) that is not yet a drag. */
const LONG_PRESS_MS = 500
const SLOP_DP = 10
/** Two-finger travel (dp) for one wheel step. */
const WHEEL_STEP_DP = 24

const nextPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })

const touchesOf = (event: GestureResponderEvent): TouchPoint[] =>
  event.nativeEvent.touches.map((touch) => ({ x: touch.locationX, y: touch.locationY }))

const ARROWS = [
  ['ArrowLeft', 'Left arrow', ArrowLeft],
  ['ArrowUp', 'Up arrow', ArrowUp],
  ['ArrowDown', 'Down arrow', ArrowDown],
  ['ArrowRight', 'Right arrow', ArrowRight],
] as const

/**
 * The agent-owned screen, live (ADR 0012; web parity:
 * apps/web/src/work/ScreenView.tsx). The client implementation holds the
 * Hermes ticket and speaks RFB; this paints the regions it returns into the
 * Kotlin picture (modules/cindl-screen) and, only while this device holds
 * control, sends taps, drags, long presses, two-finger scrolls and keys. It
 * never starts, stops or installs the screen; frames, input and the ticket
 * are never logged.
 */
export function ScreenView({ controlling }: { controlling: boolean }) {
  const api = useCindlApi()
  const theme = useTheme()
  const id = useId()
  const [view, setView] = useState<DisplayView>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const surface = screenSurfaceId(id, attempt)
  const [typing, setTyping] = useState(false)
  const keyboard = useRef<TextInputInstance>(null)
  // Read by the input callbacks between renders.
  const viewId = useRef<string>(undefined)
  const screen = useRef<{ width: number; height: number }>(undefined)
  const area = useRef<{ width: number; height: number }>(undefined)
  const longPress = useRef<ReturnType<typeof setTimeout>>(undefined)
  const input = useRef<{
    queue: ReturnType<typeof createInputQueue>
    gestures: ReturnType<typeof createGestures>
  }>(undefined)

  useEffect(() => {
    const queue = createInputQueue({
      send: (events) => {
        const id = viewId.current
        return id ? api.call('display.input', { viewId: id, events }) : Promise.resolve()
      },
      schedule: (flush) => {
        requestAnimationFrame(() => flush())
      },
      onError: (failure) =>
        setError(
          isCindlError(failure)
            ? failure.message
            : 'Cindl could not send that to the screen.',
        ),
    })
    const gestures = createGestures({
      slop: SLOP_DP,
      wheelStep: WHEEL_STEP_DP,
      fit: () =>
        area.current && screen.current
          ? fitScreen(area.current.width, area.current.height, screen.current)
          : undefined,
    })
    input.current = { queue, gestures }
    return () => {
      queue.setEnabled(false)
      input.current = undefined
    }
  }, [api])

  useEffect(() => {
    // Watching sends nothing; giving control back drops what was waiting.
    input.current?.queue.setEnabled(controlling)
    if (!controlling) keyboard.current?.blur()
  }, [api, controlling])

  const send = (events: DisplayInputEvent[]) => input.current?.queue.push(events)
  const gesture = () => input.current?.gestures

  useEffect(() => {
    if (!screenNative) return
    const painter = createScreenPainter(screenNative, surface)
    const session = startScreenSession({
      call: (name, args) => api.call(name, args),
      paint: (frame) => {
        screen.current = { width: frame.width, height: frame.height }
        return painter.paint(frame)
      },
      nextPaint,
      onView: (opened) => {
        viewId.current = opened.viewId
        screen.current = { width: opened.width, height: opened.height }
        setView(opened)
      },
      onError: setError,
    })
    return () => {
      viewId.current = undefined
      session.stop()
      painter.release()
    }
  }, [api, surface, attempt])

  const stopLongPress = () => {
    if (longPress.current !== undefined) clearTimeout(longPress.current)
    longPress.current = undefined
  }

  if (!screenNative || !ScreenSurfaceView)
    return <ErrorText>{SCREEN_MODULE_MISSING}</ErrorText>
  return (
    <View style={{ gap: theme.space[2] }}>
      <View
        style={{
          overflow: 'hidden',
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: controlling ? theme.colors.accent : theme.colors.borderStrong,
          backgroundColor: theme.colors.surfaceSunken,
        }}
      >
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={
            controlling
              ? 'The agent’s screen, live. You are in control: taps and typing go to it.'
              : 'The agent’s screen, live. Watching.'
          }
          onLayout={(event: LayoutChangeEvent) => {
            const { width, height } = event.nativeEvent.layout
            area.current = { width, height }
          }}
          style={{
            width: '100%',
            aspectRatio: view ? view.width / view.height : 16 / 10,
          }}
          onStartShouldSetResponder={() => controlling}
          onMoveShouldSetResponder={() => controlling}
          // While in control the picture keeps the gesture: the page does not scroll under it.
          onResponderTerminationRequest={() => false}
          onResponderGrant={(event) => {
            send(gesture()?.start(touchesOf(event)) ?? [])
            stopLongPress()
            longPress.current = setTimeout(() => {
              longPress.current = undefined
              send(gesture()?.longPress() ?? [])
            }, LONG_PRESS_MS)
          }}
          onResponderStart={(event) => {
            const touches = touchesOf(event)
            if (touches.length < 2) return
            stopLongPress()
            send(gesture()?.start(touches) ?? [])
          }}
          onResponderMove={(event) => {
            const moved = gesture()?.move(touchesOf(event)) ?? []
            if (moved.length) stopLongPress()
            send(moved)
          }}
          onResponderRelease={() => {
            stopLongPress()
            send(gesture()?.end() ?? [])
          }}
          onResponderTerminate={() => {
            stopLongPress()
            send(gesture()?.cancel() ?? [])
          }}
        >
          <ScreenSurfaceView
            surface={surface}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          />
        </View>
      </View>
      {controlling ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          <Button
            label={typing ? 'Hide keyboard' : 'Keyboard'}
            accessibilityLabel={
              typing ? 'Hide the keyboard' : 'Type on the agent’s screen'
            }
            icon={Keyboard}
            variant="quiet"
            onPress={() => {
              if (typing) keyboard.current?.blur()
              else keyboard.current?.focus()
            }}
          />
          {typing
            ? ARROWS.map(([key, label, Icon]) => (
                <Button
                  key={key}
                  label={label}
                  icon={Icon}
                  iconOnly
                  variant="quiet"
                  onPress={() => send(keyPress(key))}
                />
              ))
            : null}
        </View>
      ) : null}
      {/* Keys reach the screen through this field, which never keeps the text. */}
      <TextInput
        ref={keyboard}
        value=""
        editable={controlling}
        importantForAccessibility="no"
        importantForAutofill="no"
        autoComplete="off"
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        contextMenuHidden
        caretHidden
        keyboardType="visible-password"
        submitBehavior="submit"
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onChangeText={(text) => send(textToKeys(text))}
        onKeyPress={({ nativeEvent }) => {
          if (nativeEvent.key === 'Backspace') send(keyPress('Backspace'))
        }}
        onSubmitEditing={() => send(keyPress('Enter'))}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
      />
      <Note>
        {controlling
          ? 'In control. Tap to click, drag to move with the button held, long-press to right-click, two fingers to scroll; the keyboard button types.'
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
