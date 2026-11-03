import type { DisplayInputEvent } from '@cindl/contracts'

/** RFB button mask (contract DisplayInputEvent): 1 left, 2 middle, 4 right, 8 wheel up, 16 wheel down. */
export const LEFT = 1
export const RIGHT = 4
export const WHEEL_UP = 8
export const WHEEL_DOWN = 16
/** Input events per `display.input` call (the contract's limit). */
export const MAX_BATCH = 64

/** Where the picture sits in its view: centred, aspect kept (Kotlin ScreenPixels.kt `fit`). */
export interface Fit {
  left: number
  top: number
  scale: number
  screenWidth: number
  screenHeight: number
}

export function fitScreen(
  viewWidth: number,
  viewHeight: number,
  screen: { width: number; height: number },
): Fit | undefined {
  if (viewWidth <= 0 || viewHeight <= 0 || screen.width <= 0 || screen.height <= 0)
    return undefined
  const scale = Math.min(viewWidth / screen.width, viewHeight / screen.height)
  return {
    left: (viewWidth - screen.width * scale) / 2,
    top: (viewHeight - screen.height * scale) / 2,
    scale,
    screenWidth: screen.width,
    screenHeight: screen.height,
  }
}

/**
 * A point in the view as a screen pixel, through the displayed scale. Off the
 * picture it is undefined, unless `clamp` (a drag that left the picture
 * keeps going along its edge).
 */
export function toScreen(
  fit: Fit,
  x: number,
  y: number,
  clamp = false,
): { x: number; y: number } | undefined {
  const sx = Math.floor((x - fit.left) / fit.scale)
  const sy = Math.floor((y - fit.top) / fit.scale)
  const inside = sx >= 0 && sy >= 0 && sx < fit.screenWidth && sy < fit.screenHeight
  if (!inside && !clamp) return undefined
  return {
    x: Math.min(Math.max(sx, 0), fit.screenWidth - 1),
    y: Math.min(Math.max(sy, 0), fit.screenHeight - 1),
  }
}

export interface TouchPoint {
  x: number
  y: number
}

export interface GestureOptions {
  /** How far (view px) a finger may wander before a tap becomes a drag. */
  slop: number
  /** How far (view px) two fingers move for one wheel step. */
  wheelStep: number
}

type GestureState =
  | { kind: 'idle' }
  | { kind: 'ignored' }
  | { kind: 'pending'; start: TouchPoint; at: { x: number; y: number } }
  | { kind: 'dragging'; at: { x: number; y: number } }
  | { kind: 'pressed' }
  | { kind: 'scrolling'; lastY: number; travel: number; at: { x: number; y: number } }

const pointer = (at: { x: number; y: number }, buttons: number): DisplayInputEvent => ({
  type: 'pointer',
  x: at.x,
  y: at.y,
  buttons,
})

const centroid = (touches: readonly TouchPoint[]): TouchPoint => ({
  x: touches.reduce((sum, t) => sum + t.x, 0) / touches.length,
  y: touches.reduce((sum, t) => sum + t.y, 0) / touches.length,
})

/**
 * Touches on the picture as pointer input:
 * - a tap is a left click where it landed;
 * - a drag moves with the left button held, from where it started;
 * - a long press is a right click (the view calls `longPress` after the hold);
 * - two fingers moving vertically turn the wheel: up scrolls down, as on a phone.
 * A gesture that starts off the picture sends nothing.
 */
export function createGestures(options: GestureOptions & { fit: () => Fit | undefined }) {
  let state: GestureState = { kind: 'idle' }
  const scroll = (touches: readonly TouchPoint[], before: DisplayInputEvent[]) => {
    const fit = options.fit()
    const middle = centroid(touches)
    const at = fit && toScreen(fit, middle.x, middle.y, true)
    state = at
      ? { kind: 'scrolling', lastY: middle.y, travel: 0, at }
      : { kind: 'ignored' }
    return before
  }
  /** Fingers came down (or one more joined). */
  const start = (touches: readonly TouchPoint[]): DisplayInputEvent[] => {
    if (touches.length >= 2) {
      // A drag in progress lets go of its button before the wheel turns.
      const release = state.kind === 'dragging' ? [pointer(state.at, 0)] : []
      return scroll(touches, release)
    }
    const [touch] = touches
    if (state.kind !== 'idle' || !touch) return []
    const fit = options.fit()
    const at = fit && toScreen(fit, touch.x, touch.y)
    state = at ? { kind: 'pending', start: touch, at } : { kind: 'ignored' }
    return []
  }
  const move = (touches: readonly TouchPoint[]): DisplayInputEvent[] => {
    if (touches.length >= 2 && state.kind !== 'scrolling' && state.kind !== 'ignored')
      return start(touches)
    const fit = options.fit()
    if (!fit) return []
    if (state.kind === 'scrolling' && touches.length >= 2) {
      const middle = centroid(touches)
      state.travel += middle.y - state.lastY
      state.lastY = middle.y
      const out: DisplayInputEvent[] = []
      while (Math.abs(state.travel) >= options.wheelStep) {
        // Fingers moving up scroll the content down, as everywhere on a phone.
        const button = state.travel < 0 ? WHEEL_DOWN : WHEEL_UP
        out.push(pointer(state.at, button), pointer(state.at, 0))
        state.travel -= Math.sign(state.travel) * options.wheelStep
      }
      return out
    }
    const [touch] = touches
    if (!touch) return []
    if (state.kind === 'pending') {
      if (Math.hypot(touch.x - state.start.x, touch.y - state.start.y) <= options.slop)
        return []
      const at = toScreen(fit, touch.x, touch.y, true)
      if (!at) return []
      const pressed = pointer(state.at, LEFT)
      state = { kind: 'dragging', at }
      return [pressed, pointer(at, LEFT)]
    }
    if (state.kind === 'dragging') {
      const at = toScreen(fit, touch.x, touch.y, true)
      if (!at) return []
      state = { kind: 'dragging', at }
      return [pointer(at, LEFT)]
    }
    return []
  }
  return {
    start,
    move,
    /** The finger stayed put for the long-press time. */
    longPress: (): DisplayInputEvent[] => {
      if (state.kind !== 'pending') return []
      const { at } = state
      state = { kind: 'pressed' }
      return [pointer(at, RIGHT), pointer(at, 0)]
    },
    /** Every finger lifted. */
    end: (): DisplayInputEvent[] => {
      const done = state
      state = { kind: 'idle' }
      if (done.kind === 'pending') return [pointer(done.at, LEFT), pointer(done.at, 0)]
      if (done.kind === 'dragging') return [pointer(done.at, 0)]
      return []
    },
    /** The gesture was taken away (the system or a scroll view claimed it). */
    cancel: (): DisplayInputEvent[] => {
      const done = state
      state = { kind: 'idle' }
      return done.kind === 'dragging' ? [pointer(done.at, 0)] : []
    },
  }
}

/** A key pressed and released, by its DOM `KeyboardEvent.key` value. */
export const keyPress = (key: string): DisplayInputEvent[] => [
  { type: 'key', key, down: true },
  { type: 'key', key, down: false },
]

/**
 * Typed text as key presses, one per character: a line break is Enter, and
 * other control characters (and Tab, which the web never captures either)
 * are not sent.
 */
export function textToKeys(text: string): DisplayInputEvent[] {
  const out: DisplayInputEvent[] = []
  for (const character of text) {
    if (character === '\n') out.push(...keyPress('Enter'))
    else if (character >= ' ' && !/[\u007f-\u009f]/.test(character))
      out.push(...keyPress(character))
  }
  return out
}

interface Queued {
  event: DisplayInputEvent
  /** A pointer event that only moved (same buttons as the one before it). */
  move: boolean
}

/**
 * Input on its way to `display.input`. Nothing is queued unless this device is
 * in control, and giving control back drops what is waiting. Between flushes
 * only the newest position of a move counts (a press or release is never
 * merged away), and each call carries at most 64 events.
 */
export function createInputQueue(options: {
  send: (events: DisplayInputEvent[]) => Promise<unknown>
  /** Runs `flush` soon (on the next paint). */
  schedule: (flush: () => void) => void
  onError: (error: unknown) => void
}) {
  let enabled = false
  let scheduled = false
  let queue: Queued[] = []
  let lastButtons = 0
  const flush = () => {
    scheduled = false
    if (!enabled) return
    const batch = queue.splice(0, MAX_BATCH).map((entry) => entry.event)
    if (batch.length) void options.send(batch).catch(options.onError)
    if (queue.length) arm()
  }
  const arm = () => {
    if (scheduled) return
    scheduled = true
    options.schedule(flush)
  }
  return {
    setEnabled(next: boolean) {
      enabled = next
      if (!next) {
        queue = []
        lastButtons = 0
      }
    },
    push(events: readonly DisplayInputEvent[]) {
      if (!enabled) return
      for (const event of events) {
        if (event.type === 'key') {
          queue.push({ event, move: false })
          continue
        }
        const move = event.buttons === lastButtons
        lastButtons = event.buttons
        const last = queue.at(-1)
        if (move && last?.move && last.event.type === 'pointer')
          queue[queue.length - 1] = { event, move }
        else queue.push({ event, move })
      }
      if (queue.length) arm()
    },
    /** Waiting events, for tests. */
    pending: () => queue.map((entry) => entry.event),
  }
}
