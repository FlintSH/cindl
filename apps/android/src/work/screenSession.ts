import {
  isCindlError,
  type CindlClientApi,
  type DisplayFrame,
  type DisplayView,
} from '@cindl/contracts'
import type { CindlScreenNative } from '../../modules/cindl-screen/index.ts'

export const SCREEN_TOO_LARGE = 'This screen is too large to show on this device.'

/**
 * Turns frames into calls on the Kotlin surface: the picture is resized only
 * when the screen's size changes, and each changed region is painted from the
 * bytes the client returned (no copy here). False when the size is refused.
 */
export function createScreenPainter(native: CindlScreenNative, surface: string) {
  let size: { width: number; height: number } | undefined
  return {
    paint(frame: DisplayFrame): boolean {
      if (size?.width !== frame.width || size.height !== frame.height) {
        if (!native.resize(surface, frame.width, frame.height)) return false
        size = { width: frame.width, height: frame.height }
      }
      for (const region of frame.regions)
        native.paint(
          surface,
          region.x,
          region.y,
          region.width,
          region.height,
          region.rgba,
        )
      return true
    },
    release: () => native.release(surface),
  }
}

export interface ScreenSessionDeps {
  call: CindlClientApi['call']
  /** Paints a frame; false when it cannot be shown (the session then ends). */
  paint: (frame: DisplayFrame) => boolean
  /** Resolves after the next paint of the app's screen (requestAnimationFrame). */
  nextPaint: () => Promise<void>
  onView: (view: DisplayView) => void
  onError: (message: string) => void
}

/**
 * One watch of the agent's screen (web parity: apps/web/src/work/ScreenView.tsx).
 * `display.watch`, then `display.frame` again only after the last frame was
 * painted, so frames never queue up; `display.unwatch` when it stops,
 * including for a watch that resolves after it stopped. It never starts,
 * stops or installs the screen, and it never logs frames.
 */
export function startScreenSession(deps: ScreenSessionDeps): { stop: () => void } {
  let alive = true
  let viewId: string | undefined
  const unwatch = (id: string) => {
    void deps.call('display.unwatch', { viewId: id }).catch(() => undefined)
  }
  const run = async () => {
    try {
      const opened = await deps.call('display.watch', {})
      if (!alive) {
        // Stopped while the watch was on its way: end the view it opened.
        unwatch(opened.viewId)
        return
      }
      viewId = opened.viewId
      deps.onView(opened)
      while (alive) {
        const frame = await deps.call('display.frame', { viewId: opened.viewId })
        if (!alive) return
        if (!deps.paint(frame)) {
          deps.onError(SCREEN_TOO_LARGE)
          return
        }
        await deps.nextPaint()
      }
    } catch (error) {
      if (alive)
        deps.onError(
          isCindlError(error) ? error.message : 'Cindl could not show the screen.',
        )
    }
  }
  void run()
  return {
    stop: () => {
      if (!alive) return
      alive = false
      if (viewId !== undefined) unwatch(viewId)
    },
  }
}
