import {
  focusedPackage,
  onlyApp,
  overlayOpen,
  resetMove,
  type UiNode,
  type VisibleKeyboard,
} from './ui.ts'

/**
 * What the reset at each step's start reads and does on the device. device.ts
 * builds the real one from its adb primitives (`resetDeviceFrom`), so the
 * loop and its wiring are tested apart from a device.
 */
export interface ResetDevice {
  /** Cindl's own window has focus (false when the device does not say). */
  cindlInFront: () => boolean
  /** A UI dump of the window in front. */
  dump: () => Promise<UiNode>
  /** The keyboard's window and geometry (ui.ts visibleKeyboard). */
  keyboard: () => VisibleKeyboard
  /** Brings Cindl to the front, and waits for it. */
  relaunch: () => Promise<void>
  /** System back. */
  back: () => Promise<void>
}

/** One pass of the reset: what it did and why, with the keyboard's geometry when back was for it. */
export interface ResetPass {
  move: 'relaunch' | 'back' | 'done' | 'reread'
  reason: string
  /** Numbers and flags only (ui.ts visibleKeyboard). */
  keyboard?: string
}

export const RESET_PASSES = 6

/**
 * Brings the screen back to Cindl with nothing over it (ui.ts resetMove), and
 * returns what each pass did:
 * - another app in front: Cindl is relaunched, never system back;
 * - a dump that is not of Cindl's window alone settles nothing: neither done
 *   nor back, the next pass reads again (an overlay counts only from a dump
 *   of Cindl's own window);
 * - a dialog, a sheet or the keyboard's window up: system back, after focus
 *   is read once more right before it, since the dump takes time and another
 *   app can come to the front meanwhile. That narrows the window, not closes
 *   it: a few hundred milliseconds remain between the read and the key.
 * After `RESET_PASSES` passes it gives up, naming every pass (CI run
 * 41696032323: the old loop named only its last reason).
 */
export async function resetToCindl(
  device: ResetDevice,
  pkg: string,
): Promise<ResetPass[]> {
  const passes: ResetPass[] = []
  for (let pass = 0; pass < RESET_PASSES; pass++) {
    const inFront = device.cindlInFront()
    const root = inFront ? await device.dump() : undefined
    if (root !== undefined && !onlyApp(root, pkg)) {
      passes.push({ move: 'reread', reason: "the dump was not of Cindl's window alone" })
      continue
    }
    const overlay = root !== undefined && overlayOpen(root)
    const keyboard = root !== undefined ? device.keyboard() : undefined
    const move = resetMove({
      cindlInFront: inFront,
      overlay,
      keyboardUp: keyboard?.windowUp === true,
    })
    if (move === 'done') {
      passes.push({ move, reason: 'Cindl in front with nothing over it' })
      return passes
    }
    if (move === 'relaunch') {
      passes.push({ move, reason: 'another app in front' })
      await device.relaunch()
      continue
    }
    if (!device.cindlInFront()) {
      passes.push({
        move: 'relaunch',
        reason: 'another app came to the front before back',
      })
      await device.relaunch()
      continue
    }
    passes.push(
      overlay
        ? { move, reason: 'a dialog or sheet open' }
        : {
            move,
            reason: "the keyboard's window up",
            keyboard: keyboard?.geometry ?? '',
          },
    )
    await device.back()
  }
  throw new Error(
    `The screen did not come back to Cindl with nothing over it in ${RESET_PASSES} passes: ${describePasses(passes)}`,
  )
}

/** The passes as one line, in order: "1 back (the keyboard's window up: …); 2 relaunch (…)". */
export const describePasses = (passes: readonly ResetPass[]) =>
  passes
    .map(
      (pass, index) =>
        `${index + 1} ${pass.move} (${pass.reason}${pass.keyboard ? `: ${pass.keyboard}` : ''})`,
    )
    .join('; ')

/** What the reset needs of adb (device.ts gives its own primitives). */
export interface ResetIo {
  shell: (command: string) => string
  launch: () => void
  key: (code: string) => Promise<void>
  dump: () => Promise<UiNode>
  keyboard: () => VisibleKeyboard
  sleep: (ms: number) => Promise<void>
}

/** The reset's device from adb primitives: the commands each read and action is. */
export function resetDeviceFrom(io: ResetIo, pkg: string): ResetDevice {
  return {
    cindlInFront: () => {
      try {
        return (
          focusedPackage(io.shell('dumpsys window | grep -E "mCurrentFocus" || true')) ===
          pkg
        )
      } catch {
        return false
      }
    },
    dump: io.dump,
    keyboard: io.keyboard,
    relaunch: async () => {
      io.launch()
      await io.sleep(1500)
    },
    back: () => io.key('KEYCODE_BACK'),
  }
}
