import type { CindlClientApi, DisplayFrame, DisplayView } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import type { CindlScreenNative } from '../modules/cindl-screen/index.ts'
import {
  createScreenPainter,
  SCREEN_TOO_LARGE,
  startScreenSession,
} from '../src/work/screenSession.ts'

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const view: DisplayView = { viewId: 'view-test0001', width: 4, height: 3 }
const frame = (n: number): DisplayFrame => ({
  viewId: view.viewId,
  width: 4,
  height: 3,
  regions: [{ x: 0, y: 0, width: 1, height: 1, rgba: Uint8Array.of(n, n, n, 255) }],
})

/** A client whose watch and frames resolve when the test says so. */
function client() {
  let openWatch: ((opened: DisplayView) => void) | undefined
  const frames: Array<(next: DisplayFrame) => void> = []
  const calls: Array<{ name: string; args: unknown }> = []
  const api = {
    call: (name: string, args: unknown) => {
      calls.push({ name, args })
      if (name === 'display.watch')
        return new Promise<DisplayView>((resolve) => (openWatch = resolve))
      if (name === 'display.frame')
        return new Promise<DisplayFrame>((resolve) => frames.push(resolve))
      if (name === 'display.unwatch') return Promise.resolve({ stopped: true })
      return Promise.reject(new Error(`unexpected ${name}`))
    },
  } as unknown as Pick<CindlClientApi, 'call'>
  return {
    call: api.call,
    calls,
    named: (name: string) => calls.filter((c) => c.name === name),
    open: () => openWatch?.(view),
    sendFrame: (n: number) => frames.shift()?.(frame(n)),
  }
}

function session(c: ReturnType<typeof client>, paintResult = true) {
  const painted: number[] = []
  const errors: string[] = []
  let paintDone: (() => void) | undefined
  const handle = startScreenSession({
    call: c.call,
    paint: (next) => {
      painted.push(next.regions[0]?.rgba[0] ?? -1)
      return paintResult
    },
    nextPaint: () => new Promise<void>((resolve) => (paintDone = resolve)),
    onView: () => undefined,
    onError: (message) => errors.push(message),
  })
  return { handle, painted, errors, paintedOnScreen: () => paintDone?.() }
}

describe('watching the agent screen (web parity)', () => {
  it('ends the view when the screen closes', async () => {
    const c = client()
    const s = session(c)
    c.open()
    await settle()
    s.handle.stop()
    await settle()
    expect(c.named('display.unwatch').map((call) => call.args)).toEqual([
      { viewId: 'view-test0001' },
    ])
  })

  it('ends a view whose watch resolves after the screen closed', async () => {
    const c = client()
    const s = session(c)
    s.handle.stop()
    c.open()
    await settle()
    expect(c.named('display.unwatch').map((call) => call.args)).toEqual([
      { viewId: 'view-test0001' },
    ])
    expect(c.named('display.frame')).toEqual([])
  })

  it('asks for the next frame only after the last one was painted', async () => {
    const c = client()
    const s = session(c)
    c.open()
    await settle()
    expect(c.named('display.frame')).toHaveLength(1)
    c.sendFrame(1)
    await settle()
    expect(s.painted).toEqual([1])
    // Painted into the bitmap, but not on screen yet: no new request.
    expect(c.named('display.frame')).toHaveLength(1)
    s.paintedOnScreen()
    await settle()
    expect(c.named('display.frame')).toHaveLength(2)
  })

  it('paints nothing that arrives after it stopped', async () => {
    const c = client()
    const s = session(c)
    c.open()
    await settle()
    s.handle.stop()
    c.sendFrame(1)
    await settle()
    expect(s.painted).toEqual([])
    expect(c.named('display.frame')).toHaveLength(1)
  })

  it('says why a screen cannot be shown, and stops asking for frames', async () => {
    const c = client()
    const s = session(c, false)
    c.open()
    await settle()
    c.sendFrame(1)
    await settle()
    expect(s.errors).toEqual([SCREEN_TOO_LARGE])
    expect(c.named('display.frame')).toHaveLength(1)
  })
})

describe('painting regions into the native picture', () => {
  function native(accept = true) {
    const calls: unknown[][] = []
    const fake: CindlScreenNative = {
      resize: (...args) => {
        calls.push(['resize', ...args])
        return accept
      },
      paint: (...args) => {
        calls.push(['paint', ...args.slice(0, 5)])
        return true
      },
      release: (surface) => void calls.push(['release', surface]),
    }
    return { fake, calls }
  }

  it('sizes the picture once per screen size and paints each region from the bytes it got', () => {
    const { fake, calls } = native()
    const painter = createScreenPainter(fake, 'screen-1')
    const first = frame(1)
    expect(painter.paint(first)).toBe(true)
    expect(painter.paint(frame(2))).toBe(true)
    painter.paint({ ...frame(3), width: 8, height: 6 })
    painter.release()
    expect(calls).toEqual([
      ['resize', 'screen-1', 4, 3],
      ['paint', 'screen-1', 0, 0, 1, 1],
      ['paint', 'screen-1', 0, 0, 1, 1],
      ['resize', 'screen-1', 8, 6],
      ['paint', 'screen-1', 0, 0, 1, 1],
      ['release', 'screen-1'],
    ])
  })

  it('hands the native side the very array the client returned', () => {
    let seen: Uint8Array | undefined
    const painter = createScreenPainter(
      {
        resize: () => true,
        paint: (...args) => ((seen = args[5]), true),
        release: () => undefined,
      },
      'screen-1',
    )
    const first = frame(1)
    painter.paint(first)
    expect(seen).toBe(first.regions[0]?.rgba)
  })

  it('paints nothing on a screen the native side refuses to size', () => {
    const { fake, calls } = native(false)
    expect(createScreenPainter(fake, 'screen-1').paint(frame(1))).toBe(false)
    expect(calls).toEqual([['resize', 'screen-1', 4, 3]])
  })
})
