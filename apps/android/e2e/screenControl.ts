import type { DisplayViewer } from '@cindl/fixtures/fake-hermes'

/**
 * The agent's screen in control, as the emulator suites drive it: take
 * control, act (a tap the screen answers with its marker), then give control
 * back. `whileInControl` runs between acting and giving back, because the
 * fake Hermes forgets which viewer held control as soon as the lease returns
 * to the agent (fake-hermes gateway.ts, #leaseChanged). Control is given back
 * even when that check fails, so later steps start from a watched screen; the
 * check's error is the one reported.
 */
export async function inControl(
  steps: {
    takeControl: () => Promise<void>
    act: () => Promise<void>
    giveBack: () => Promise<void>
  },
  whileInControl: () => void,
): Promise<void> {
  await steps.takeControl()
  await steps.act()
  let missing: Error | undefined
  try {
    whileInControl()
  } catch (error) {
    missing = error instanceof Error ? error : new Error(String(error))
  }
  await steps.giveBack()
  if (missing) throw missing
}

/**
 * What the fake Hermes saw of that control: among the screen viewers opened
 * since `before`, the one holding control, and how many input messages its
 * lease gate passed. Throws when no new viewer holds control or none of its
 * input passed.
 */
export function heldControl(
  before: Iterable<DisplayViewer>,
  now: Iterable<DisplayViewer>,
): { passedInput: number } {
  const old = new Set(before)
  const held = [...now].find((viewer) => !old.has(viewer) && viewer.heldEver)
  if (!held) throw new Error('No screen view held control on the fake Hermes')
  if (held.filter.passedInput === 0)
    throw new Error('No input reached the fake Hermes through its lease gate')
  return { passedInput: held.filter.passedInput }
}
