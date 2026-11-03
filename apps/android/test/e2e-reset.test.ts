import { describe, expect, it } from 'vitest'
import {
  describePasses,
  RESET_PASSES,
  resetDeviceFrom,
  resetNote,
  resetToCindl,
  type ResetDevice,
} from '../e2e/reset.ts'
import { parseUi, type UiNode, type VisibleKeyboard } from '../e2e/ui.ts'

// The reset at each step's start (delta check of 4a7727e, S1 to S3): the loop
// and its wiring, on a scripted device. CI run 41696032323 pressed back on a
// bare Talk at every step start; these pin what each pass may do.

const PKG = 'dev.fl1nt.cindl'
const LAUNCHER = 'com.android.launcher3'
const node = (pkg: string, more: string) =>
  `<node text="" class="android.view.ViewGroup" package="${pkg}" content-desc="" checkable="false" checked="false" enabled="true" focused="false" scrollable="false" long-clickable="false" selected="false" ${more} />`
const screen = (...nodes: string[]) =>
  parseUi(
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node text="" class="android.widget.FrameLayout" package="${PKG}" content-desc="" clickable="false" bounds="[0,0][1080,2400]" drawing-order="0">${nodes.join('')}</node></hierarchy>`,
  )
/** Talk after a relaunch (CI run 41696032323, 11-relaunched.xml): nothing open. */
const TALK = screen(
  node(
    PKG,
    'content-desc="Talk" clickable="true" bounds="[0,2127][270,2274]" drawing-order="5"',
  ),
)
/** A sheet left open: Cindl's scrim, told by its resource-id (src/overlay/scrim.ts). */
const SHEET = screen(
  node(
    PKG,
    'resource-id="cindl-scrim" clickable="false" focusable="false" bounds="[0,0][1080,2400]" drawing-order="1"',
  ),
  node(
    PKG,
    'content-desc="Close" clickable="true" bounds="[900,1300][1050,1420]" drawing-order="2"',
  ),
)
/** A dump that is not of Cindl's window alone (another app's node in it). */
const MIXED = screen(
  node(LAUNCHER, 'clickable="true" bounds="[0,0][1080,2400]" drawing-order="1"'),
)
const hidden: VisibleKeyboard = {
  windowUp: false,
  visible: false,
  geometry: 'window view 0x8',
}
const up: VisibleKeyboard = {
  windowUp: true,
  visible: false,
  geometry: 'window view 0x0, surface true; frame [0,2274][1080,2400]',
}

/** A device whose reads come from scripts in turn (the last repeats), recording what it is asked to do. */
function scripted(script: {
  front: boolean[]
  dumps?: UiNode[]
  keyboards?: VisibleKeyboard[]
}) {
  const at = <T>(list: T[], i: number) => list[Math.min(i, list.length - 1)] as T
  let f = 0
  let d = 0
  let k = 0
  const did: string[] = []
  const device: ResetDevice = {
    cindlInFront: () => at(script.front, f++),
    dump: () => {
      did.push('dump')
      return Promise.resolve(at(script.dumps ?? [TALK], d++))
    },
    keyboard: () => at(script.keyboards ?? [hidden], k++),
    relaunch: () => {
      did.push('relaunch')
      return Promise.resolve()
    },
    back: () => {
      did.push('back')
      return Promise.resolve()
    },
  }
  return { device, did }
}

describe('the reset at a step start', () => {
  it('relaunches Cindl over another app, and never presses back there', async () => {
    const { device, did } = scripted({ front: [false, true] })
    const passes = await resetToCindl(device, PKG)
    expect(passes.map((p) => p.move)).toEqual(['relaunch', 'done'])
    expect(did).toEqual(['relaunch', 'dump'])
  })

  it('presses back for a sheet left open in Cindl, then stops on a bare screen', async () => {
    const { device, did } = scripted({ front: [true], dumps: [SHEET, TALK] })
    const passes = await resetToCindl(device, PKG)
    expect(passes).toEqual([
      { move: 'back', reason: 'a dialog or sheet open' },
      { move: 'done', reason: 'Cindl in front with nothing over it' },
    ])
    expect(did).toEqual(['dump', 'back', 'dump'])
  })

  it('reads focus again right before back: another app that came in front meanwhile gets no back', async () => {
    // In front for the first read, not for the one right before back.
    const { device, did } = scripted({ front: [true, false, true], dumps: [SHEET, TALK] })
    const passes = await resetToCindl(device, PKG)
    expect(passes.map((p) => p.move)).toEqual(['relaunch', 'done'])
    expect(passes[0]?.reason).toBe('another app came to the front before back')
    expect(did).not.toContain('back')
  })

  it("takes an overlay only from a dump of Cindl's window alone, and stops on no other", async () => {
    // A scrim that is another app's: neither back nor done; the next pass reads again.
    const { device, did } = scripted({ front: [true], dumps: [MIXED, TALK] })
    const passes = await resetToCindl(device, PKG)
    expect(passes).toEqual([
      { move: 'reread', reason: "the dump was not of Cindl's window alone" },
      { move: 'done', reason: 'Cindl in front with nothing over it' },
    ])
    expect(did).toEqual(['dump', 'dump'])
  })

  it("presses back for the keyboard's window only while it is up, noting its geometry", async () => {
    const { device, did } = scripted({ front: [true], keyboards: [up, hidden] })
    const passes = await resetToCindl(device, PKG)
    expect(passes[0]).toEqual({
      move: 'back',
      reason: "the keyboard's window up",
      keyboard: 'window view 0x0, surface true; frame [0,2274][1080,2400]',
    })
    expect(did).toEqual(['dump', 'back', 'dump'])
    // A hidden keyboard's window (whatever flag the input method holds): no back.
    const bare = scripted({ front: [true], keyboards: [hidden] })
    expect((await resetToCindl(bare.device, PKG)).map((p) => p.move)).toEqual(['done'])
    expect(bare.did).toEqual(['dump'])
  })

  it('gives up after a bounded number of passes, naming every one of them', async () => {
    // The keyboard's window never goes, and back leaves the app each time.
    const front = Array.from({ length: 3 * RESET_PASSES }, (_, i) => i % 3 !== 2)
    const { device } = scripted({ front, keyboards: [up] })
    const error = await resetToCindl(device, PKG).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(error?.message).toMatch(
      new RegExp(
        `^The screen did not come back to Cindl with nothing over it in ${RESET_PASSES} passes: 1 back`,
      ),
    )
    expect(error?.message.match(/\b\d+ (?:back|relaunch|done|reread) \(/g)).toHaveLength(
      RESET_PASSES,
    )
    expect(error?.message).toContain("back (the keyboard's window up: window view 0x0")
    expect(error?.message).toContain('relaunch (another app in front)')
    expect(describePasses([{ move: 'done', reason: 'r' }])).toBe('1 done (r)')
  })
})

describe('what a reset leaves in the report (delta check of 7dab9fe, notes 7 and 8)', () => {
  it('names the passes it took before a read or an action failed', async () => {
    // A sheet left open, closed by back; then the dump fails.
    const { device } = scripted({ front: [true], dumps: [SHEET] })
    let dumps = 0
    const failing: ResetDevice = {
      ...device,
      dump: () => {
        dumps += 1
        return dumps === 1
          ? device.dump()
          : Promise.reject(new Error('uiautomator: could not get idle state'))
      },
    }
    const error = await resetToCindl(failing, PKG).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(error?.message).toBe(
      'The reset failed: uiautomator: could not get idle state. Its passes so far: 1 back (a dialog or sheet open)',
    )
    // A relaunch that fails is named as the pass it was.
    const launcher = scripted({ front: [false] })
    const relaunchFails: ResetDevice = {
      ...launcher.device,
      relaunch: () => Promise.reject(new Error('am start: no answer')),
    }
    expect(
      await resetToCindl(relaunchFails, PKG).then(
        () => '',
        (e: unknown) => (e as Error).message,
      ),
    ).toBe(
      'The reset failed: am start: no answer. Its passes so far: 1 relaunch (another app in front)',
    )
  })

  it('notes a reset only when it took more than one pass, naming each', () => {
    const done = { move: 'done', reason: 'Cindl in front with nothing over it' } as const
    expect(resetNote([done])).toBeUndefined()
    expect(resetNote([{ move: 'back', reason: 'a dialog or sheet open' }, done])).toBe(
      '1 back (a dialog or sheet open); 2 done (Cindl in front with nothing over it)',
    )
  })
})

describe("the reset's adb wiring", () => {
  function io(focus: string | Error) {
    const did: string[] = []
    return {
      did,
      device: resetDeviceFrom(
        {
          shell: (command) => {
            did.push(`shell ${command}`)
            if (focus instanceof Error) throw focus
            return focus
          },
          launch: () => void did.push('launch'),
          key: (code) => {
            did.push(`key ${code}`)
            return Promise.resolve()
          },
          dump: () => Promise.resolve(TALK),
          keyboard: () => hidden,
          sleep: (ms) => {
            did.push(`sleep ${ms}`)
            return Promise.resolve()
          },
        },
        PKG,
      ),
    }
  }

  it("reads Cindl's focus from mCurrentFocus, relaunches with a launch and a wait, and backs with KEYCODE_BACK", async () => {
    const cindl = io(`  mCurrentFocus=Window{623897a u0 ${PKG}/${PKG}.MainActivity}\n`)
    expect(cindl.device.cindlInFront()).toBe(true)
    expect(cindl.did).toEqual(['shell dumpsys window | grep -E "mCurrentFocus" || true'])
    await cindl.device.relaunch()
    await cindl.device.back()
    expect(cindl.did.slice(1)).toEqual(['launch', 'sleep 1500', 'key KEYCODE_BACK'])
    const launcher = io(
      `  mCurrentFocus=Window{1b2c3d4 u0 ${LAUNCHER}/${LAUNCHER}.Launcher}\n`,
    )
    expect(launcher.device.cindlInFront()).toBe(false)
    expect(io(new Error('adb: device offline')).device.cindlInFront()).toBe(false)
  })
})
