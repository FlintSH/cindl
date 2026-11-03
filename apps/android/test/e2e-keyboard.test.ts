import { describe, expect, it } from 'vitest'
import { DEVICE_SETTINGS } from '../e2e/device.ts'
import { keyboardMoment, settledKeyboard, type KeyboardReader } from '../e2e/keyboard.ts'
import type { VisibleKeyboard } from '../e2e/ui.ts'

// The keyboard step of the emulator run (CI run 41681122382 passed on a keyboard
// Android called shown while none was on screen, and read the keyboard before
// the composer's dump and screenshot, not with them).

const on = (top: number, height: number): VisibleKeyboard => ({
  visible: true,
  top,
  height,
  geometry: `frame top ${top}, ${height} high`,
})
/** Shown by Android's flags, but its top at the display's bottom edge: not on screen. */
const OFF: VisibleKeyboard = {
  visible: false,
  geometry: 'frame [0,1377][1080,2400]; content inset top 1023',
}

/** A device whose keyboard reads come from `reads` in turn (the last repeats), on a clock that sleeping moves. */
function scripted(reads: VisibleKeyboard[]) {
  let clock = 0
  let index = 0
  const log: string[] = []
  const reader: KeyboardReader = {
    onScreen: () => {
      const read = reads[Math.min(index++, reads.length - 1)] ?? OFF
      log.push(`read ${read.top ?? 'off'}`)
      return read
    },
    sleep: (ms) => {
      clock += ms
      log.push(`sleep ${ms}`)
      return Promise.resolve()
    },
    now: () => clock,
  }
  return { reader, log }
}

describe('the keyboard on screen and still', () => {
  it('waits for it to be on screen, then to hold still', async () => {
    const { reader } = scripted([OFF, on(1500, 900), on(1377, 1023), on(1377, 1023)])
    expect(await settledKeyboard(reader, 8_000)).toEqual(on(1377, 1023))
  })

  it('gives up when it is only ever shown, never on screen', async () => {
    const { reader, log } = scripted([OFF])
    expect(await settledKeyboard(reader, 8_000)).toBeUndefined()
    expect(log.filter((line) => line.startsWith('sleep'))).toHaveLength(16)
  })
})

describe("the keyboard and the composer's bounds from one moment", () => {
  it('reads the keyboard just before the capture and just after it', async () => {
    const { reader, log } = scripted([on(1377, 1023)])
    const moment = await keyboardMoment(reader, (attempt) => {
      log.push(`capture ${attempt}`)
      return Promise.resolve('composer')
    })
    expect(moment).toEqual({ keyboard: on(1377, 1023), at: 'composer' })
    expect(log).toEqual(['read 1377', 'capture 1', 'read 1377'])
  })

  it('captures again when the keyboard moved meanwhile', async () => {
    const { reader } = scripted([on(1500, 900), on(1377, 1023)])
    const captures: number[] = []
    const moment = await keyboardMoment(reader, (attempt) => {
      captures.push(attempt)
      return Promise.resolve(attempt)
    })
    expect(moment).toMatchObject({ at: 2, keyboard: { top: 1377, height: 1023 } })
    expect(captures).toEqual([1, 2])
  })

  it('has no moment when the keyboard went off screen during the capture, or never held still', async () => {
    const gone = scripted([on(1377, 1023), OFF])
    expect(await keyboardMoment(gone.reader, () => Promise.resolve('composer'))).toBe(
      undefined,
    )
    const restless = scripted([on(1300, 1100), on(1320, 1080), on(1340, 1060)])
    expect(
      await keyboardMoment(restless.reader, () => Promise.resolve('composer'), 1),
    ).toBeUndefined()
  })
})

describe('the emulator shows the on-screen keyboard', () => {
  it('beside the hardware keyboard it reports, with settings only (no package, no terms)', () => {
    // CI run 41681122382: every configuration line reads qwerty/v/v, so Android's
    // keyboard showed its window and navigation strip but no keys (23-keyboard.png).
    expect(DEVICE_SETTINGS).toContain('settings put secure show_ime_with_hard_keyboard 1')
    for (const setting of DEVICE_SETTINGS)
      expect(setting).toMatch(
        /^(?:settings put (?:global|system|secure) [a-z_]+ [\w.]+|cmd uimode night no)$/,
      )
  })
})
