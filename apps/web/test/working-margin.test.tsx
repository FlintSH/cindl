// The working margin as the conversation's panel (ADR 0013): a few tools for
// this conversation, switched only by the owner. Real shell and views on the
// synthetic scenario, in a wide window (the margin as a column).
import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi, CindlEvent } from '@cindl/contracts'
import { createScenarioClient, scenarioData } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/shell/AppShell.tsx'
import { forgetPlaces, keepPlace, noteSwitch, placeOf } from '../src/talk/places.ts'

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

/** The synthetic scenario, with a way to emit an event as Hermes would. */
async function renderShell(hash = '#/talk/demo-main') {
  window.history.replaceState(null, '', hash)
  const scenario = createScenarioClient({ speed: 0 })
  const listeners = new Set<(event: CindlEvent) => void>()
  const calls: string[] = []
  const api: CindlClientApi = {
    call: (name, args) => {
      calls.push(name)
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
