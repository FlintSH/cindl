import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Keyboard, View, type HostInstance } from 'react-native'
import { keyboardOverlap } from './keyboardOverlap.ts'

const KeyboardContext = createContext(0)

/**
 * Space, in dp, that the on-screen keyboard covers at the bottom of the app
 * (0 when hidden). Cindl draws edge to edge on every Android version
 * (edgeToEdgeEnabled), so the window does not shrink for the keyboard; the
 * overlap is measured against the app's root view rather than assumed, so it
 * stays right on a device that shrinks the window anyway. The shell and sheets
 * pad themselves by this amount so the composer and inputs stay visible.
 */
export function KeyboardProvider({ children }: { children: ReactNode }) {
  const root = useRef<HostInstance>(null)
  const [rootBottom, setRootBottom] = useState(0)
  const [keyboardTop, setKeyboardTop] = useState<number>()
  const measure = useCallback(() => {
    root.current?.measureInWindow((_x, y, _width, height) => setRootBottom(y + height))
  }, [])
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      measure()
      setKeyboardTop(event.endCoordinates.screenY)
    })
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(undefined))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [measure])
  return (
    <KeyboardContext.Provider value={keyboardOverlap(rootBottom, keyboardTop)}>
      <View ref={root} style={{ flex: 1 }} onLayout={measure} collapsable={false}>
        {children}
      </View>
    </KeyboardContext.Provider>
  )
}

/** Keyboard overlap at the bottom of the app, in dp; 0 when the keyboard is hidden. */
export function useKeyboardHeight(): number {
  return useContext(KeyboardContext)
}
