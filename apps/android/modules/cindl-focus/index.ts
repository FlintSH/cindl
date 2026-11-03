import { requireOptionalNativeModule } from 'expo'

/**
 * The Kotlin focus calls (android/src/main/java/dev/fl1nt/cindl/focus). Each
 * takes a view's tag. Both answer false when they do nothing (a view that is
 * no group, touch mode, nothing focusable).
 */
export interface CindlFocusNative {
  /** Keeps hardware keyboard focus out of the view's descendants while `blocked`. */
  block(viewTag: number, blocked: boolean): Promise<boolean>
  /** Keyboard focus to the view, else to its nearest ancestor's first control. */
  focus(viewTag: number): Promise<boolean>
}

/** Null when the native module is not linked into this build. */
export const focusNative = requireOptionalNativeModule<CindlFocusNative>('CindlFocus')
