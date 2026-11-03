import { nativeLog } from './react-native.tsx'

/**
 * Expo's native module lookup in jsdom: the keyboard focus module
 * (modules/cindl-focus) records its calls in `nativeLog`, with the view it was
 * given (findNodeHandle hands over the element); no other module is linked.
 */
export function requireOptionalNativeModule<T>(name: string): T | null {
  if (name !== 'CindlFocus') return null
  const focus = {
    block(node: unknown, blocked: boolean) {
      nativeLog.push({ kind: 'keyboard-block', node, blocked })
      return Promise.resolve(true)
    },
    focus(node: unknown) {
      nativeLog.push({ kind: 'keyboard-focus', node })
      return Promise.resolve(true)
    },
  }
  return focus as T
}

export function requireNativeView() {
  return () => null
}
