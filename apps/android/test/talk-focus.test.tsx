/** @vitest-environment jsdom */
import { createScenarioClient } from '@cindl/fixtures/scenario'
import type { CindlClientApi } from '@cindl/contracts'
import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../src/markdown/Markdown.tsx'
import { forgetPresses } from '../src/overlay/opener.ts'
import { BehindOverlays } from '../src/overlay/Portal.tsx'
import { TalkView } from '../src/talk/TalkView.tsx'
import { Providers } from './memoryScreen.tsx'
import { hardwareBack, nativeLog } from './render/react-native.tsx'

// What gives focus back as an overlay closes, on the shipped components
// (delta check of 7dab9fe, S2 and S5): TalkView on the synthetic scenario,
// behind the overlays' hiding as AppShell renders it, and links in agent
// Markdown. memoryScreen.tsx's hooks clean up after each test.

beforeEach(() => {
  // Date too: an overlay's opener is a press in the second before it opened.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'))
  forgetPresses()
})

/** A node focus was sent to, by its role and name. */
function nameOf(node: unknown): string {
  if (!(node instanceof HTMLElement)) return String(node)
  const role = node.getAttribute('role')
  const label = node.getAttribute('aria-label') ?? node.textContent ?? ''
  return role ? `${role}: ${label}` : label
}

function screen(ui: React.ReactNode) {
  const view = render(ui)
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
  let seen = nativeLog.length
  return {
    container: view.container,
    settle,
    async press(name: string | RegExp, role = 'button') {
      const target = [
        ...view.container.querySelectorAll<HTMLElement>(`[role="${role}"]`),
      ].find((element) => {
        const label = element.getAttribute('aria-label') ?? element.textContent ?? ''
        return typeof name === 'string' ? label === name : name.test(label)
      })
      if (!target) throw new Error(`no ${role} ${String(name)}`)
      fireEvent.click(target)
      await settle()
    },
    async back() {
      act(() => void hardwareBack())
      await settle()
    },
    async wait(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    },
    /** Where TalkBack focus and a keyboard's were sent since the last call. */
    sent() {
      const entries = nativeLog.slice(seen)
      seen = nativeLog.length
      return {
        talkBack: entries.flatMap((e) => (e.kind === 'focus' ? [nameOf(e.node)] : [])),
        keyboard: entries.flatMap((e) =>
          e.kind === 'keyboard-focus' ? [nameOf(e.node)] : [],
        ),
      }
    },
  }
}

async function talk() {
  const s = screen(
    <Providers api={createScenarioClient({ speed: 0 })}>
      <BehindOverlays>
        <TalkView />
      </BehindOverlays>
    </Providers>,
  )
  for (let round = 0; round < 5; round++) await s.settle()
  s.sent()
  return s
}

const SWITCHER = 'button: Today, Main. Switch conversation'
const STEP = /^Checked the studio calendar for Thursday\. /

describe('Talk: what opens an overlay gets focus back when it closes', () => {
  it('a tool row, for the working margin it opens (P2)', async () => {
    const s = await talk()
    await s.press(STEP)
    expect(s.sent().talkBack).toEqual(['heading: Step details'])
    await s.back()
    const { talkBack } = s.sent()
    expect(talkBack).toHaveLength(1)
    expect(talkBack[0]).toMatch(/^button: Checked the studio calendar for Thursday\. /)
  })

  it("the margin's Show moves focus to the card, TalkBack's and a keyboard's, and the margin gives none back (S2, P3)", async () => {
    const s = await talk()
    await s.press('Show the working margin')
    expect(s.sent().talkBack).toEqual(['heading: Waiting on you'])
    await s.press('Show approval: Run the inventory export script')
    await s.wait(300)
    // The card's title only: no focus back to "Show the working margin". A
    // keyboard's goes to the title too, which hands it to the card's first
    // control (modules/cindl-focus).
    expect(s.sent()).toEqual({
      talkBack: ['heading: Approval needed: Run the inventory export script'],
      keyboard: ['heading: Approval needed: Run the inventory export script'],
    })
  })

  it('the conversation switcher, for the conversations it opens, though another press came just before (P4)', async () => {
    const s = await talk()
    // A press less than a second before the switcher's: the switcher is the opener.
    await s.press('Show the working margin')
    await s.back()
    s.sent()
    await s.press('Today, Main. Switch conversation')
    expect(s.sent().talkBack).toEqual(['heading: Conversations'])
    await s.back()
    expect(s.sent().talkBack).toEqual([SWITCHER])
  })
})

describe('a link in agent Markdown gets focus back when its confirmation closes', () => {
  const client = {
    call: () => Promise.reject(new Error('no calls here')),
    subscribe: () => () => undefined,
  } as unknown as CindlClientApi
  const TEXT = [
    'Directions are on [the venue page](https://harbor-loft.example.test/directions).',
    '',
    '## The [floor plan](https://harbor-loft.example.test/plan)',
    '',
    '| Room | Map |',
    '| --- | --- |',
    '| Loft | [the loft map](https://harbor-loft.example.test/loft) |',
  ].join('\n')

  /** Presses the link, cancels its confirmation, and says where focus went back. */
  async function cancelled(link: string) {
    const s = screen(
      <Providers api={client}>
        <BehindOverlays>
          <Markdown text={TEXT} />
        </BehindOverlays>
      </Providers>,
    )
    await s.settle()
    await s.press(link, 'link')
    expect(s.sent().talkBack).toEqual(['heading: Open this link?'])
    await s.press('Cancel')
    return s.sent().talkBack
  }

  it("in a paragraph: to the paragraph's text, its host (P5)", async () => {
    expect(await cancelled('the venue page')).toEqual([
      'Directions are on the venue page (harbor-loft.example.test).',
    ])
  })

  it('in a heading: to the heading (S6)', async () => {
    expect(await cancelled('floor plan')).toEqual([
      'heading: The floor plan (harbor-loft.example.test)',
    ])
  })

  it("in a table cell: to the cell's text (S6)", async () => {
    expect(await cancelled('the loft map')).toEqual([
      'the loft map (harbor-loft.example.test)',
    ])
  })
})
