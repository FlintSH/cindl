import type { VisibleKeyboard } from './ui.ts'

/** How the keyboard step reads the device (`device.keyboardOnScreen`), and waits. */
export interface KeyboardReader {
  onScreen: () => VisibleKeyboard
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const sameOnScreen = (a: VisibleKeyboard, b: VisibleKeyboard) =>
  a.top !== undefined &&
  a.height !== undefined &&
  a.top === b.top &&
  a.height === b.height

/**
 * Waits up to `ms` for the keyboard to be on screen (ui.ts visibleKeyboard) and
 * hold still: the same top and height on two reads 500 ms apart. Undefined if
 * it never did.
 */
export async function settledKeyboard(
  reader: KeyboardReader,
  ms: number,
): Promise<VisibleKeyboard | undefined> {
  const until = reader.now() + ms
  let last = reader.onScreen()
  while (reader.now() < until) {
    await reader.sleep(500)
    const now = reader.onScreen()
    if (sameOnScreen(now, last)) return now
    last = now
  }
  return undefined
}

/**
 * What `capture` takes (the composer's bounds from a UI dump, and a
 * screenshot) and the keyboard's geometry from one moment: the keyboard is
 * read just before the capture and just after it, and both reads must find it
 * on screen, unchanged. Tried `tries` times, a second apart; undefined if it
 * never held still.
 */
export async function keyboardMoment<T>(
  reader: KeyboardReader,
  capture: (attempt: number) => Promise<T>,
  tries = 3,
): Promise<
  { keyboard: VisibleKeyboard & { top: number; height: number }; at: T } | undefined
> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const before = reader.onScreen()
    const at = await capture(attempt)
    const after = reader.onScreen()
    if (
      sameOnScreen(after, before) &&
      after.top !== undefined &&
      after.height !== undefined
    )
      return { keyboard: { ...after, top: after.top, height: after.height }, at }
    if (attempt < tries) await reader.sleep(1000)
  }
  return undefined
}
