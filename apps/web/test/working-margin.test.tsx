// The working margin as the conversation's panel (ADR 0013): a few tools for
// this conversation, switched only by the owner. Real shell and views on the
// synthetic scenario, in a wide window (the margin as a column).
import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi, CindlEvent } from '@cindl/contracts'
import { createScenarioClient, scenarioData } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/shell/AppShell.tsx'
import {
  forgetPlaces,
  keepPlace,
  noteSwitch,
  placeOf,
  takeSwitch,
} from '../src/talk/places.ts'

beforeEach(() => {
  // jsdom has no matchMedia: a wide window, where the margin is a column.
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === '(min-width: 1280px)',
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})

afterEach(() => {
  cleanup()
  forgetPlaces()
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })

const goTo = async (hash: string) => {
  window.location.hash = hash
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  await settle()
  await settle()
}

/**
 * The synthetic scenario, with a way to emit an event as Hermes would, and
 * optionally a take-control that waits until `landAcquire` lets it through.
 */
async function renderShell(hash = '#/talk/demo-main', { holdAcquire = false } = {}) {
  window.history.replaceState(null, '', hash)
  const scenario = createScenarioClient({ speed: 0 })
  const listeners = new Set<(event: CindlEvent) => void>()
  const calls: string[] = []
  let land: (() => void) | undefined
  const api: CindlClientApi = {
    call: (name: never, args: never) => {
      calls.push(name)
      if (holdAcquire && name === 'display.acquireControl')
        return new Promise((resolve, reject) => {
          land = () => {
            scenario.call(name, args).then(resolve, reject)
          }
        })
      return scenario.call(name, args)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      const stop = scenario.subscribe(listener)
      return () => {
        listeners.delete(listener)
        stop()
      }
    },
  }
  render(
    <CindlProvider api={api}>
      <AppShell />
    </CindlProvider>,
  )
  await settle()
  await settle()
  return {
    calls,
    scenario,
    landAcquire: () =>
      act(async () => {
        land?.()
        for (let i = 0; i < 6; i++) await Promise.resolve()
      }),
    emit: (event: CindlEvent) =>
      act(async () => {
        for (const listener of listeners) listener(event)
        await Promise.resolve()
      }),
  }
}

const margin = () => within(screen.getByRole('complementary', { name: 'Working margin' }))
const tab = (name: RegExp) => margin().getByRole('tab', { name })
const selected = () =>
  margin()
    .getAllByRole('tab')
    .filter((t) => t.getAttribute('aria-selected') === 'true')
    .map((t) => t.textContent)

describe('the working margin, as the conversation’s panel', () => {
  it('opens on what the conversation waits on, with the count on its tab', async () => {
    await renderShell()
    // Each tool is named by its visible text, count included.
    expect(margin().getByRole('tab', { name: 'Waiting 2' })).toBeTruthy()
    expect(
      margin()
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Waiting 2', 'Step', 'Computer'])
    expect(selected()).toEqual(['Waiting 2'])
    const panel = margin().getByRole('tabpanel')
    expect(
      within(panel).getByRole('button', {
        name: /Show approval: Run the inventory export script/,
      }),
    ).toBeTruthy()
  })

  it('shows a selected step on Step, and Clear the step leaves it empty', async () => {
    await renderShell()
    // Even with Waiting chosen, selecting a step opens it on Step.
    fireEvent.click(tab(/^Waiting/))
    fireEvent.click(screen.getByRole('button', { name: /Checked the studio calendar/ }))
    await settle()
    expect(selected()).toEqual(['Step'])
    expect(margin().getByText('calendar.search')).toBeTruthy()
    fireEvent.click(margin().getByRole('button', { name: 'Clear the step' }))
    await settle()
    expect(margin().getByText(/Select a step in the conversation/)).toBeTruthy()
  })

  it('keeps each conversation’s own tool while the owner moves between them', async () => {
    await renderShell()
    fireEvent.click(tab(/^Step$/))
    await goTo('#/talk/demo-inventory')
    expect(selected()).toEqual(['Waiting 1'])
    await goTo('#/talk/demo-main')
    expect(selected()).toEqual(['Step'])
  })

  it('moves between tools with the arrow keys, Home and End, as a tab list', async () => {
    await renderShell()
    const waiting = tab(/^Waiting/)
    waiting.focus()
    fireEvent.keyDown(waiting, { key: 'ArrowRight' })
    await settle()
    expect(selected()).toEqual(['Step'])
    expect(document.activeElement).toBe(tab(/^Step$/))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    await settle()
    expect(selected()).toEqual(['Waiting 2'])
    expect(tab(/^Step$/).getAttribute('tabindex')).toBe('-1')
  })

  it('never switches tools by itself: a new request changes the count, not the tool', async () => {
    const hermes = await renderShell()
    fireEvent.click(tab(/^Step$/))
    const [first] = scenarioData.requests.filter((r) => r.conversationId === 'demo-main')
    await hermes.emit({
      type: 'request.opened',
      request: {
        ...first!,
        requestId: 'srq-0000000fe1c3',
        title: 'Another synthetic approval (fixture)',
      },
    })
    await settle()
    expect(selected()).toEqual(['Step'])
    expect(tab(/^Waiting/).textContent).toBe('Waiting 3')
  })

  it('un-pressing a step leaves Step chosen, as "Clear the step" does', async () => {
    await renderShell()
    const step = screen.getByRole('button', { name: /Checked the studio calendar/ })
    fireEvent.click(step)
    await settle()
    fireEvent.click(step)
    await settle()
    expect(selected()).toEqual(['Step'])
    expect(margin().getByText(/Select a step in the conversation/)).toBeTruthy()
  })

  it('keeps the selected step while another tool is chosen, for when Step is chosen again', async () => {
    await renderShell()
    fireEvent.click(screen.getByRole('button', { name: /Checked the studio calendar/ }))
    await settle()
    fireEvent.click(tab(/^Waiting/))
    await settle()
    expect(selected()).toEqual(['Waiting 2'])
    fireEvent.click(tab(/^Step$/))
    await settle()
    expect(margin().getByText('calendar.search')).toBeTruthy()
  })

  it('"Clear the step" leaves focus on the Step tab', async () => {
    await renderShell()
    fireEvent.click(screen.getByRole('button', { name: /Checked the studio calendar/ }))
    await settle()
    fireEvent.click(margin().getByRole('button', { name: 'Clear the step' }))
    await settle()
    expect(document.activeElement).toBe(tab(/^Step$/))
  })

  it('moves from the tab that has focus, and leaves modified arrows to the browser', async () => {
    await renderShell()
    fireEvent.click(tab(/^Step$/))
    await settle()
    // Focus on a tab that is not the chosen one, as a dialog can leave it.
    const waiting = tab(/^Waiting/)
    waiting.focus()
    fireEvent.keyDown(waiting, { key: 'ArrowRight' })
    await settle()
    expect(selected()).toEqual(['Step'])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(document.activeElement!, { key: 'End', ctrlKey: true })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(document.activeElement!, { key: 'Home', metaKey: true })
    await settle()
    expect(selected()).toEqual(['Step'])
  })

  it('says why the Computer tool shows no screen when Hermes does not offer one', async () => {
    const hermes = await renderShell()
    await hermes.emit({
      type: 'capabilities.changed',
      capabilities: {
        'computer.view': {
          id: 'computer.view',
          state: 'unsupported',
          reason: 'This Hermes has no agent screen (fixture).',
          source: { transport: 'derived' },
        },
      },
    })
    fireEvent.click(tab(/^Computer$/))
    await settle()
    expect(margin().getByText(/Agent computer: Not supported\./)).toBeTruthy()
    expect(margin().getByText(/This Hermes has no agent screen/)).toBeTruthy()
    expect(hermes.calls).not.toContain('display.watch')
  })

  it('forgets every place when the session ends, however it ended', async () => {
    const hermes = await renderShell()
    keepPlace('demo-main', { draft: 'Unsent (fixture)', tool: 'computer' })
    await hermes.emit({
      type: 'link.changed',
      link: {
        phase: 'signed-out',
        demo: false,
        since: new Date().toISOString(),
        connectionEpoch: 2,
      },
    })
    await settle()
    expect(placeOf('demo-main')).toEqual({
      draft: '',
      scrollTop: undefined,
      toolId: undefined,
      tool: undefined,
    })
  })

  it('gives control back for a take-control that lands after the Computer tool was left', async () => {
    const hermes = await renderShell('#/talk/demo-main', { holdAcquire: true })
    // State and lease only (no live picture in jsdom), with control allowed.
    const capabilities = await hermes.scenario.call('capabilities.get', {})
    await hermes.emit({
      type: 'capabilities.changed',
      capabilities: {
        ...capabilities,
        'computer.view': {
          id: 'computer.view',
          state: 'limited',
          reason: 'Screen state and lease only (fixture).',
          source: { transport: 'derived' },
        },
      },
    })
    fireEvent.click(tab(/^Computer$/))
    await settle()
    fireEvent.click(margin().getByRole('button', { name: 'Take control…' }))
    fireEvent.click(margin().getByRole('button', { name: 'Take control now' }))
    await settle()
    // Left while the take-control is still on its way: nothing to give back yet.
    fireEvent.click(tab(/^Waiting/))
    await settle()
    expect(hermes.calls).not.toContain('display.releaseControl')
    await hermes.landAcquire()
    await settle()
    expect(hermes.calls.filter((name) => name === 'display.releaseControl')).toHaveLength(
      1,
    )
    const display = await hermes.scenario.call('display.status', {})
    expect(display.leaseHeldByThisDevice).toBe(false)
  })

  it('gives nothing back for control another viewer took before the Computer tool was left', async () => {
    const hermes = await renderShell('#/talk/demo-main')
    const capabilities = await hermes.scenario.call('capabilities.get', {})
    await hermes.emit({
      type: 'capabilities.changed',
      capabilities: {
        ...capabilities,
        'computer.view': {
          id: 'computer.view',
          state: 'limited',
          reason: 'Screen state and lease only (fixture).',
          source: { transport: 'derived' },
        },
      },
    })
    fireEvent.click(tab(/^Computer$/))
    await settle()
    fireEvent.click(margin().getByRole('button', { name: 'Take control…' }))
    fireEvent.click(margin().getByRole('button', { name: 'Take control now' }))
    await settle()
    expect(margin().getByText('You are in control on this device')).toBeTruthy()
    // Another viewer takes control: this device holds nothing to give back.
    await hermes.emit({
      type: 'display.changed',
      display: {
        status: 'running',
        controller: 'another-viewer',
        leaseHeldByThisDevice: false,
      },
    })
    await settle()
    fireEvent.click(tab(/^Waiting/))
    await settle()
    expect(hermes.calls).not.toContain('display.releaseControl')
  })

  it('lets the tool panel itself be reached from the tabs', async () => {
    await renderShell()
    expect(margin().getByRole('tabpanel').getAttribute('tabindex')).toBe('0')
  })

  it('choosing the conversation already shown opens nothing; choosing another focuses its switcher', async () => {
    // jsdom has no <dialog>: open and close it as a browser would.
    const proto = HTMLDialogElement.prototype
    // Saved as values: jsdom may not have them at all.
    const saved = proto as unknown as Record<'showModal' | 'close', unknown>
    const before = { showModal: saved.showModal, close: saved.close }
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
    try {
      await renderShell('#/talk')
      const switcher = () => screen.getByRole('button', { name: /Switch conversation/ })
      fireEvent.click(switcher())
      await settle()
      const list = within(screen.getByRole('dialog', { name: 'Conversations' }))
      fireEvent.click(list.getByRole('button', { name: /Today/ }))
      await settle()
      // At #/talk the main conversation is the one shown: the address stays.
      expect(window.location.hash).toBe('#/talk')
      expect(takeSwitch()).toBe(false)
      fireEvent.click(switcher())
      await settle()
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Conversations' })).getByRole(
          'button',
          {
            name: /Kiln inventory sheet/,
          },
        ),
      )
      await settle()
      await settle()
      expect(window.location.hash).toBe('#/talk/demo-inventory')
      expect(document.activeElement).toBe(switcher())
    } finally {
      saved.showModal = before.showModal
      saved.close = before.close
    }
  })

  it('closing the column from the keyboard puts focus on its toggle only when focus was in it', async () => {
    await renderShell()
    tab(/^Step$/).focus()
    fireEvent.keyDown(document.activeElement!, { key: '.', ctrlKey: true })
    await settle()
    const toggle = screen.getByRole('button', { name: 'Show the working margin' })
    expect(document.activeElement).toBe(toggle)
    // Reopened with focus in the message box, and closed again: focus stays there.
    fireEvent.keyDown(document.activeElement!, { key: '.', ctrlKey: true })
    await settle()
    const box = screen.getByRole('textbox', { name: 'Message Hermes' })
    box.focus()
    fireEvent.keyDown(box, { key: '.', ctrlKey: true })
    await settle()
    expect(document.activeElement).toBe(box)
  })

  it('forgets a pending switch note when the session ends', () => {
    noteSwitch()
    forgetPlaces()
    expect(takeSwitch()).toBe(false)
  })

  it('puts focus on the switcher of a conversation chosen from the switcher, and only then', async () => {
    await renderShell()
    await goTo('#/talk/demo-inventory')
    const switcher = () => screen.getByRole('button', { name: /Switch conversation/ })
    expect(document.activeElement).not.toBe(switcher())
    noteSwitch()
    await goTo('#/talk/demo-main')
    expect(document.activeElement).toBe(switcher())
  })
})
