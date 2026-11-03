import { nodeBinarySocketFactory } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { harness } from '../../../packages/client-core/test/direct-harness.ts'
import { heldControl, inControl } from '../e2e/screenControl.ts'

// The emulator suite's check that a tap in control reached the fake Hermes
// (e2e/run.ts, "Work: the fake Hermes's screen"), run here on loopback with
// the direct client the app uses: watch, take control, a press and release at
// the marker's point, give control back. SYNTHETIC data only.

describe("the fake Hermes's view of control", () => {
  it('is read while the app is in control: given back, the fake no longer says who held it', async () => {
    const h = await harness({ deps: { displaySocketFactory: nodeBinarySocketFactory() } })
    await h.waitFor(
      () => h.store.getState().capabilities['computer.view']?.state === 'available',
    )
    const before = [...h.fake.gateway.displayViewers]
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.frame', { viewId })
    let seen: { passedInput: number } | undefined
    await inControl(
      {
        takeControl: async () => {
          await h.client.call('display.acquireControl', { confirm: true })
        },
        act: async () => {
          await h.client.call('display.input', {
            viewId,
            events: [
              { type: 'pointer', x: 320, y: 376, buttons: 1 },
              { type: 'pointer', x: 320, y: 376, buttons: 0 },
            ],
          })
          await h.waitFor(() =>
            [...h.fake.gateway.displayViewers].some((v) => v.filter.passedInput === 2),
          )
        },
        giveBack: async () => {
          await h.client.call('display.releaseControl', {})
        },
      },
      () => {
        seen = heldControl(before, h.fake.gateway.displayViewers)
      },
    )
    expect(seen).toEqual({ passedInput: 2 })
    expect(h.fake.store.display.holder).toBe('agent')
    // What the step did before: the same check after control went back fails.
    expect(() => heldControl(before, h.fake.gateway.displayViewers)).toThrow(
      'No screen view held control on the fake Hermes',
    )
  })

  it('gives control back even when the fake saw no control, and reports that', async () => {
    const order: string[] = []
    const run = inControl(
      {
        takeControl: () => Promise.resolve(void order.push('take')),
        act: () => Promise.resolve(void order.push('tap')),
        giveBack: () => Promise.resolve(void order.push('give back')),
      },
      () => {
        order.push('check')
        heldControl([], [])
      },
    )
    await expect(run).rejects.toThrow('No screen view held control on the fake Hermes')
    expect(order).toEqual(['take', 'tap', 'check', 'give back'])
  })
})
