import type { DisplayInputEvent } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  createGestures,
  createInputQueue,
  fitScreen,
  keyPress,
  LEFT,
  MAX_BATCH,
  RIGHT,
  textToKeys,
  toScreen,
  WHEEL_DOWN,
  WHEEL_UP,
} from '../src/work/screenInput.ts'

const SCREEN = { width: 640, height: 400 }
const p = (x: number, y: number, buttons: number): DisplayInputEvent => ({
  type: 'pointer',
  x,
  y,
  buttons,
})

describe('touch points through the displayed scale', () => {
  it('maps a point of a letterboxed picture to its screen pixel', () => {
    // 640x400 in a 400x400 view: scale 0.625, 75 px bands above and below.
    const fit = fitScreen(400, 400, SCREEN)
    if (!fit) throw new Error('no fit')
    expect(fit).toEqual({
      left: 0,
      top: 75,
      scale: 0.625,
      screenWidth: 640,
      screenHeight: 400,
    })
    expect(toScreen(fit, 0, 75)).toEqual({ x: 0, y: 0 })
    expect(toScreen(fit, 200, 200)).toEqual({ x: 320, y: 200 })
    expect(toScreen(fit, 399.9, 324.9)).toEqual({ x: 639, y: 399 })
    // In the bands nothing is hit, unless a drag is clamped to the edge.
    expect(toScreen(fit, 200, 10)).toBeUndefined()
    expect(toScreen(fit, 200, 10, true)).toEqual({ x: 320, y: 0 })
    expect(fitScreen(0, 400, SCREEN)).toBeUndefined()
  })
})

describe('gestures on the picture', () => {
  // A picture shown at twice its size: view points are screen points times two.
  const gestures = () =>
    createGestures({
      slop: 16,
      wheelStep: 40,
      fit: () => fitScreen(1280, 800, SCREEN),
    })

  it('makes a tap a left click where it landed', () => {
    const g = gestures()
    expect(g.start([{ x: 200, y: 600 }])).toEqual([])
    expect(g.move([{ x: 205, y: 604 }])).toEqual([])
    expect(g.end()).toEqual([p(100, 300, LEFT), p(100, 300, 0)])
  })

  it('makes a drag move with the left button held, from where it started', () => {
    const g = gestures()
    g.start([{ x: 200, y: 600 }])
    expect(g.move([{ x: 260, y: 600 }])).toEqual([p(100, 300, LEFT), p(130, 300, LEFT)])
    expect(g.move([{ x: 300, y: 640 }])).toEqual([p(150, 320, LEFT)])
    // Off the picture the drag follows its edge.
    expect(g.move([{ x: 1400, y: 640 }])).toEqual([p(639, 320, LEFT)])
    expect(g.end()).toEqual([p(639, 320, 0)])
  })

  it('makes a long press a right click', () => {
    const g = gestures()
    g.start([{ x: 200, y: 600 }])
    expect(g.longPress()).toEqual([p(100, 300, RIGHT), p(100, 300, 0)])
    expect(g.move([{ x: 400, y: 600 }])).toEqual([])
    expect(g.end()).toEqual([])
  })

  it('turns the wheel with two fingers moving vertically, up scrolling down', () => {
    const g = gestures()
    g.start([{ x: 200, y: 600 }])
    expect(
      g.start([
        { x: 200, y: 600 },
        { x: 400, y: 600 },
      ]),
    ).toEqual([])
    const fingersUp = g.move([
      { x: 200, y: 515 },
      { x: 400, y: 515 },
    ])
    // 85 px up: two steps of 40, at the screen point between the fingers.
    expect(fingersUp).toEqual([
      p(150, 300, WHEEL_DOWN),
      p(150, 300, 0),
      p(150, 300, WHEEL_DOWN),
      p(150, 300, 0),
    ])
    expect(
      g.move([
        { x: 200, y: 560 },
        { x: 400, y: 560 },
      ]),
    ).toEqual([p(150, 300, WHEEL_UP), p(150, 300, 0)])
    // The tap that started it is not sent.
    expect(g.end()).toEqual([])
  })

  it('lets go of a held button before the wheel turns, and when the gesture is taken away', () => {
    const g = gestures()
    g.start([{ x: 200, y: 600 }])
    g.move([{ x: 260, y: 600 }])
    expect(
      g.start([
        { x: 260, y: 600 },
        { x: 400, y: 600 },
      ]),
    ).toEqual([p(130, 300, 0)])
    const h = gestures()
    h.start([{ x: 200, y: 600 }])
    h.move([{ x: 260, y: 600 }])
    expect(h.cancel()).toEqual([p(130, 300, 0)])
  })

  it('sends nothing for a gesture that starts off the picture', () => {
    const g = createGestures({
      slop: 16,
      wheelStep: 40,
      fit: () => fitScreen(400, 400, SCREEN),
    })
    g.start([{ x: 200, y: 10 }])
    expect(g.move([{ x: 300, y: 200 }])).toEqual([])
    expect(g.end()).toEqual([])
  })
})

describe('the input queue', () => {
  function queue() {
    const sent: DisplayInputEvent[][] = []
    const flushes: Array<() => void> = []
    const q = createInputQueue({
      send: (events) => {
        sent.push(events)
        return Promise.resolve()
      },
      schedule: (flush) => flushes.push(flush),
      onError: () => undefined,
    })
    const paint = () => flushes.shift()?.()
    return { q, sent, paint }
  }

  it('sends nothing while watching, not even later, and drops what waits when control ends', () => {
    const { q, sent, paint } = queue()
    q.push([p(1, 1, LEFT), p(1, 1, 0)])
    paint()
    expect(sent).toEqual([])
    // Taking control later does not send what was touched while watching.
    q.setEnabled(true)
    q.push([p(2, 2, LEFT)])
    paint()
    expect(sent).toEqual([[p(2, 2, LEFT)]])
    q.push([p(3, 3, 0)])
    q.setEnabled(false)
    paint()
    expect(sent).toEqual([[p(2, 2, LEFT)]])
  })

  it('keeps only the newest position of a move, never merging a press or release', () => {
    const { q, sent, paint } = queue()
    q.setEnabled(true)
    q.push([p(10, 10, LEFT), p(11, 10, LEFT)])
    q.push([p(12, 10, LEFT)])
    q.push([p(13, 10, LEFT), p(13, 10, 0)])
    paint()
    expect(sent).toEqual([[p(10, 10, LEFT), p(13, 10, LEFT), p(13, 10, 0)]])
  })

  it('sends at most 64 events per call', () => {
    const { q, sent, paint } = queue()
    q.setEnabled(true)
    q.push(textToKeys('x'.repeat(40)))
    paint()
    paint()
    expect(sent.map((batch) => batch.length)).toEqual([MAX_BATCH, 80 - MAX_BATCH])
  })
})

describe('keys', () => {
  it('types text as key presses, a line break as Enter, and leaves control characters out', () => {
    expect(textToKeys('a\nb\t')).toEqual([
      ...keyPress('a'),
      ...keyPress('Enter'),
      ...keyPress('b'),
    ])
    expect(textToKeys('é')).toEqual(keyPress('é'))
    expect(keyPress('Backspace')).toEqual([
      { type: 'key', key: 'Backspace', down: true },
      { type: 'key', key: 'Backspace', down: false },
    ])
  })
})
