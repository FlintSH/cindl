/** Returns true when it consumed the back press. */
export type BackHandlerFn = () => boolean

export interface BackDispatcher {
  /** Registers a handler above every earlier one; returns its unregister function. */
  push: (handler: BackHandlerFn) => () => void
  /** Offers the press to the most recently registered handler first. */
  dispatch: () => boolean
}

/**
 * Android system back, in one explicit order: whatever registered last
 * (an open sheet or dialog, then an editor with unsaved changes) handles it
 * before screen navigation, which registers first. When nothing handles it,
 * Android's default applies and the app goes to the background.
 */
export function createBackDispatcher(): BackDispatcher {
  const stack: Array<{ handler: BackHandlerFn }> = []
  return {
    push(handler) {
      const entry = { handler }
      stack.push(entry)
      return () => {
        const index = stack.indexOf(entry)
        if (index >= 0) stack.splice(index, 1)
      }
    },
    dispatch() {
      for (let index = stack.length - 1; index >= 0; index--)
        if (stack[index]?.handler()) return true
      return false
    },
  }
}
