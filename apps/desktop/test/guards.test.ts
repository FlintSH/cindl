import { describe, expect, it } from 'vitest'
import {
  createGestureTracker,
  GESTURE_WINDOW_MS,
  sandboxDisabledBy,
} from '../src/main/guards.ts'

describe('sandbox guard', () => {
  const switches =
    (...names: string[]) =>
    (name: string) =>
      names.includes(name)

  it.each([
    [['no-sandbox'], '--no-sandbox'],
    [['no-zygote-sandbox'], '--no-zygote-sandbox'],
    [['disable-seccomp-filter-sandbox'], '--disable-seccomp-filter-sandbox'],
  ])('notices %j', (names, reason) => {
    expect(sandboxDisabledBy(switches(...names), {})).toBe(reason)
  })

  it('notices ELECTRON_DISABLE_SANDBOX', () => {
    expect(sandboxDisabledBy(switches(), { ELECTRON_DISABLE_SANDBOX: '1' })).toBe(
      'ELECTRON_DISABLE_SANDBOX',
    )
  })

  it('accepts a normal launch', () => {
    expect(
      sandboxDisabledBy(switches('ozone-platform', 'user-data-dir'), {}),
    ).toBeUndefined()
  })
})

describe('user gesture tracker', () => {
  function tracker() {
    let time = 1_000
    const gestures = createGestureTracker({ now: () => time })
    return { gestures, advance: (ms: number) => (time += ms) }
  }

  it('authorizes one link per click, shortly after it', () => {
    const { gestures, advance } = tracker()
    expect(gestures.consume()).toBe(false)
    gestures.pointer('mouseUp')
    advance(100)
    expect(gestures.consume()).toBe(true)
    expect(gestures.consume()).toBe(false)
    gestures.pointer('mouseUp')
    advance(GESTURE_WINDOW_MS + 1)
    expect(gestures.consume()).toBe(false)
  })

  it('counts activation keys and taps, not typing or movement', () => {
    const { gestures } = tracker()
    for (const key of ['a', 'Tab', 'Escape', 'ArrowDown']) {
      gestures.key('keyDown', key)
      expect(gestures.consume()).toBe(false)
    }
    gestures.key('keyUp', 'Enter')
    expect(gestures.consume()).toBe(false)
    for (const type of ['mouseMove', 'mouseDown', 'mouseWheel', 'mouseEnter']) {
      gestures.pointer(type)
      expect(gestures.consume()).toBe(false)
    }
    gestures.key('keyDown', 'Enter')
    expect(gestures.consume()).toBe(true)
    gestures.key('keyDown', ' ')
    expect(gestures.consume()).toBe(true)
    gestures.pointer('gestureTap')
    expect(gestures.consume()).toBe(true)
  })
})
