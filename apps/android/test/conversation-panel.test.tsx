/** @vitest-environment jsdom */
import { createScenarioClient } from '@cindl/fixtures/scenario'
import type {
  CapabilityMap,
  CindlClientApi,
  CindlEvent,
  ServerRequest,
} from '@cindl/contracts'
import { act, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DestinationActiveProvider } from '../src/nav/NavProvider.tsx'
import { forgetPresses } from '../src/overlay/opener.ts'
import { BehindOverlays } from '../src/overlay/Portal.tsx'
import { placeOf } from '../src/talk/places.ts'
import { TalkView } from '../src/talk/TalkView.tsx'
import { WorkView } from '../src/work/WorkView.tsx'
import { Providers } from './memoryScreen.tsx'
import { hardwareBack, nativeLog } from './render/react-native.tsx'

// The working margin as the conversation's panel (ADR 0013; web parity:
// apps/web/test/working-margin.test.tsx): the shipped TalkView, behind the
// overlays' hiding as AppShell renders it, on the synthetic scenario.
// memoryScreen.tsx's hooks clean up after each test (places included).

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'))
  forgetPresses()
})

/** The scenario, recording calls, able to hold one until let go, and to send events of its own. */
function scenario() {
  const real = createScenarioClient({ speed: 0 })
  const listeners = new Set<(event: CindlEvent) => void>()
  let capabilities: CapabilityMap = {}
  const calls: string[] = []
  const holding = new Set<string>()
  const held = new Map<string, () => void>()
  const api = {
    call: async (name: string, args: unknown) => {
      calls.push(name)
      if (holding.delete(name)) await new Promise<void>((go) => held.set(name, go))
      return real.call(name as never, args as never)
    },
    subscribe: (listener: (event: CindlEvent) => void) => {
      listeners.add(listener)
      const off = real.subscribe((event) => {
        if (event.type === 'capabilities.changed') capabilities = event.capabilities
        listener(event)
      })
      return () => {
        listeners.delete(listener)
        off()
      }
    },
  } as unknown as CindlClientApi
  return {
    api,
    calls,
    /** The next call by this name waits until `go`. */
    hold: (name: string) => void holding.add(name),
    go: (name: string) => held.get(name)?.(),
    emit: (event: CindlEvent) => {
      for (const listener of [...listeners]) listener(event)
    },
    /** The scenario's capabilities, with some replaced. */
    capabilities: (change: CapabilityMap) => ({ ...capabilities, ...change }),
  }
}

function screen(ui: (shown: boolean) => ReactNode) {
  const view = render(ui(true))
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
  const all = (role: string) => [
    ...view.container.querySelectorAll<HTMLElement>(`[role="${role}"]`),
  ]
  const nameOf = (element: HTMLElement) =>
    element.getAttribute('aria-label') ?? element.textContent ?? ''
  let seen = nativeLog.length
  return {
    container: view.container,
    settle,
    async rerender(shown: boolean) {
      view.rerender(ui(shown))
      await settle()
    },
    async press(name: string | RegExp, role = 'button') {
      const target = all(role).find((element) =>
        typeof name === 'string' ? nameOf(element) === name : name.test(nameOf(element)),
      )
      if (!target) throw new Error(`no ${role} ${String(name)}`)
      fireEvent.click(target)
      await settle()
    },
    async back() {
      act(() => void hardwareBack())
      await settle()
    },
    async type(text: string) {
      const box = view.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message Hermes"]',
      )
      if (!box) throw new Error('no composer')
      fireEvent.change(box, { target: { value: text } })
      await settle()
    },
    composer: () =>
      view.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message Hermes"]',
      )?.value,
    /** The margin's tabs: name, and whether selected. */
    tabs: () =>
      all('tab').map(
        (tab) =>
          `${nameOf(tab)}${tab.getAttribute('aria-selected') === 'true' ? ' *' : ''}`,
      ),
    has: (text: string) =>
      [...view.container.querySelectorAll('[data-rn="Text"]')].some(
        (node) => node.textContent === text,
      ),
    open: () =>
      view.container.querySelector('[aria-label="Close the working margin"]') !== null,
    /** Where TalkBack focus was sent since the last call, by role and name. */
    sent() {
      const entries = nativeLog.slice(seen)
      seen = nativeLog.length
      return entries.flatMap((entry) =>
        entry.kind === 'focus' && entry.node instanceof HTMLElement
          ? [`${entry.node.getAttribute('role') ?? ''}: ${nameOf(entry.node)}`]
          : [],
      )
    },
  }
}

async function talk(s = scenario()) {
  const t = screen(() => (
    <Providers api={s.api}>
      <BehindOverlays>
        <TalkView />
      </BehindOverlays>
    </Providers>
  ))
  for (let round = 0; round < 5; round++) await t.settle()
  t.sent()
  return Object.assign(t, { s })
}

const STEP = /^Checked the studio calendar for Thursday\. /
const STEP_EMPTY = 'Select a step in the conversation to see what Hermes did.'

describe('the working margin, as the conversation’s panel', () => {
  it('opens from the conversation on Waiting, with the count on its tab and focus there', async () => {
    const t = await talk()
    await t.press('Show the working margin')
    expect(t.tabs()).toEqual(['Waiting 2 *', 'Step', 'Computer'])
    expect(t.sent()).toEqual(['tab: Waiting 2'])
    expect(
      t.container.querySelector(
        '[aria-label="Show approval: Run the inventory export script"]',
      ),
    ).not.toBeNull()
  })

  it('opens on Step when a step is selected; Clear the step empties it, Step stays chosen, focus on its tab', async () => {
    const t = await talk()
    await t.press(STEP)
    expect(t.open()).toBe(true)
    expect(t.tabs()).toEqual(['Waiting 2', 'Step *', 'Computer'])
    expect(t.has('calendar.search')).toBe(true)
    t.sent()
    await t.press('Clear the step')
    expect(t.has('calendar.search')).toBe(false)
    expect(t.has(STEP_EMPTY)).toBe(true)
    expect(t.tabs()).toEqual(['Waiting 2', 'Step *', 'Computer'])
    expect(t.sent()).toEqual(['tab: Step'])
  })

  it('un-selecting a step clears it without opening the margin, and Step stays chosen', async () => {
    const t = await talk()
    await t.press(STEP)
    await t.back()
    expect(t.open()).toBe(false)
    await t.press(STEP)
    expect(t.open()).toBe(false)
    expect(placeOf('demo-main')).toMatchObject({ toolId: undefined, tool: 'step' })
    await t.press('Show the working margin')
    expect(t.tabs()).toEqual(['Waiting 2', 'Step *', 'Computer'])
    expect(t.has(STEP_EMPTY)).toBe(true)
  })

  it('never switches tools by itself: a new request changes the count, not the tool', async () => {
    const t = await talk()
    await t.press(STEP)
    const request: ServerRequest = {
      requestId: 'srq-00000000dea9',
      hermesApprovalId: 'apr-demo-9',
      lastSeenEpoch: 1,
      kind: 'approval',
      conversationId: 'demo-main',
      title: 'Copy the kiln log to the shared drive',
      command: 'cp kiln.log /mnt/shared/ (fixture)',
      description: 'A synthetic request for this test.',
      toolName: 'terminal',
      choices: ['once', 'deny'],
      withheldChoices: [],
      receivedAt: '2026-06-01T09:00:00.000Z',
      status: 'open',
    }
    await act(async () => {
      t.s.emit({ type: 'request.opened', request })
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(t.tabs()).toEqual(['Waiting 3', 'Step *', 'Computer'])
  })

  it('closes with system back, focus going back to what opened it', async () => {
    const t = await talk()
    await t.press('Show the working margin')
    t.sent()
    await t.back()
    expect(t.open()).toBe(false)
    expect(t.sent()).toEqual(['button: Show the working margin'])
  })

  it('keeps each conversation’s own tool and draft, never another’s', async () => {
    const t = await talk()
    await t.type('Ask about the glaze order (fixture)')
    await t.press('Show the working margin')
    await t.press('Computer', 'tab')
    await t.back()
    // Another conversation: its own (default) tool and an empty composer.
    await t.press('Today, Main. Switch conversation')
    await t.press(/^Kiln inventory sheet/)
    expect(t.composer()).toBe('')
    await t.press('Show the working margin')
    expect(t.tabs()).toEqual(['Waiting 1 *', 'Step', 'Computer'])
    await t.back()
    // Back to the main conversation: its tool and its draft.
    await t.press(/^Kiln inventory sheet.*Switch conversation$/)
    await t.press(/^Today, Main/)
    expect(t.composer()).toBe('Ask about the glaze order (fixture)')
    await t.press('Show the working margin')
    expect(t.tabs()).toEqual(['Waiting 2', 'Step', 'Computer *'])
  })
})

describe('the margin’s Computer tool', () => {
  it('says why it shows no screen when Hermes offers none', async () => {
    const t = await talk()
    await t.press('Show the working margin')
    await act(async () => {
      t.s.emit({
        type: 'capabilities.changed',
        capabilities: t.s.capabilities({
          'computer.view': {
            id: 'computer.view',
            state: 'unavailable',
            reason: 'This Hermes runs no agent screen (fixture).',
            source: { transport: 'none', endpoint: 'test' },
          },
        }),
      })
      await vi.advanceTimersByTimeAsync(100)
    })
    await t.press('Computer', 'tab')
    expect(
      [...t.container.querySelectorAll('[data-rn="Text"]')].some((node) =>
        (node.textContent ?? '').startsWith(
          'Agent computer: Unavailable. This Hermes runs no agent screen (fixture).',
        ),
      ),
    ).toBe(true)
  })

  it('gives control back as the owner leaves the tool, if this device took it there', async () => {
    const t = await talk()
    await t.press('Show the working margin')
    await t.press('Computer', 'tab')
    await t.press('Take control…')
    await t.press('Take control now')
    expect(t.s.calls).toContain('display.acquireControl')
    expect(t.s.calls).not.toContain('display.releaseControl')
    await t.press('Waiting 2', 'tab')
    expect(t.s.calls.at(-1)).toBe('display.releaseControl')
  })

  it('gives control back when "Take control now" lands after the owner left (the web’s review)', async () => {
    const t = await talk()
    await t.press('Show the working margin')
    await t.press('Computer', 'tab')
    await t.press('Take control…')
    t.s.hold('display.acquireControl')
    await t.press('Take control now')
    // The margin closes while the take is out; it lands after.
    await t.back()
    expect(t.s.calls).not.toContain('display.releaseControl')
    await act(async () => {
      t.s.go('display.acquireControl')
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(t.s.calls.slice(-2)).toEqual([
      'display.acquireControl',
      'display.releaseControl',
    ])
  })

  it('hides the margin from TalkBack while its "Take control" dialog is open over it', async () => {
    const t = await talk()
    await t.press('Show the working margin')
    await t.press('Computer', 'tab')
    const close = () =>
      t.container.querySelector('[aria-label="Close the working margin"]')
    const covered = () => Boolean(close()?.closest('[aria-hidden="true"]'))
    /** What was asked of the focus module for the view that holds the margin. */
    const blocks = () =>
      nativeLog.flatMap((entry) =>
        entry.kind === 'keyboard-block' &&
        entry.node instanceof HTMLElement &&
        close() !== null &&
        entry.node.contains(close())
          ? [entry.blocked]
          : [],
      )
    expect(covered()).toBe(false)
    expect(blocks()).toEqual([])
    await t.press('Take control…')
    expect(covered()).toBe(true)
    expect(blocks()).toEqual([true])
    await t.press('Cancel')
    expect(covered()).toBe(false)
    expect(blocks()).toEqual([true, false])
  })
})

describe('Work’s Computer', () => {
  it('gives control back once Work is no longer the destination shown', async () => {
    const s = scenario()
    const w = screen((shown) => (
      <Providers api={s.api}>
        <BehindOverlays>
          <DestinationActiveProvider value={shown}>
            <WorkView />
          </DestinationActiveProvider>
        </BehindOverlays>
      </Providers>
    ))
    for (let round = 0; round < 5; round++) await w.settle()
    await w.press('Take control…')
    await w.press('Take control now')
    expect(s.calls).not.toContain('display.releaseControl')
    await w.rerender(false)
    expect(s.calls.at(-1)).toBe('display.releaseControl')
  })
})
