/**
 * Process-level guards that do not need Electron to be tested: the sandbox
 * check at startup and the record of trusted user input that link opening
 * depends on.
 */

/** Chromium switches that turn the renderer sandbox off. */
export const SANDBOX_OFF_SWITCHES = [
  'no-sandbox',
  'no-zygote-sandbox',
  'disable-seccomp-filter-sandbox',
] as const

/** Explicit, documented opt-in for environments with no usable sandbox. */
export const UNSAFE_NO_SANDBOX_ENV = 'CINDL_UNSAFE_NO_SANDBOX'

/**
 * What turned the sandbox off, if anything. AppImage launchers add
 * `--no-sandbox` by themselves when unprivileged user namespaces are
 * unavailable; Cindl refuses to show agent output that way.
 */
export function sandboxDisabledBy(
  hasSwitch: (name: string) => boolean,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const name of SANDBOX_OFF_SWITCHES) if (hasSwitch(name)) return `--${name}`
  if (env.ELECTRON_DISABLE_SANDBOX) return 'ELECTRON_DISABLE_SANDBOX'
  return undefined
}

/** How long a click or an Enter/Space press authorizes one link to open. */
export const GESTURE_WINDOW_MS = 1500

/**
 * Trusted user input, as main saw it arrive from the operating system (not
 * anything the renderer claims). Opening a link consumes the gesture, so one
 * click opens at most one link, and nothing opens without a click or key.
 */
export function createGestureTracker(
  options: { now?: () => number; windowMs?: number } = {},
) {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? GESTURE_WINDOW_MS
  let last = Number.NEGATIVE_INFINITY
  return {
    /** A mouse button release or tap. */
    pointer: (type: string) => {
      if (type === 'mouseUp' || type === 'gestureTap') last = now()
    },
    /** A key press; only activation keys count (typing does not open links). */
    key: (type: string, key: string) => {
      if (type === 'keyDown' && (key === 'Enter' || key === ' ')) last = now()
    },
    consume: (): boolean => {
      if (now() - last > windowMs) return false
      last = Number.NEGATIVE_INFINITY
      return true
    },
  }
}

export type GestureTracker = ReturnType<typeof createGestureTracker>
