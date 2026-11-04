/** @vitest-environment jsdom */
import { CindlError } from '@cindl/contracts'
import type { CindlClientApi, VersionedDocument } from '@cindl/contracts'
import { act, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DestinationActiveProvider } from '../src/nav/NavProvider.tsx'
import { BottomNav } from '../src/shell/BottomNav.tsx'
import { Button, Row } from '../src/ui/primitives.tsx'
import { DocumentEditor } from '../src/views/DocumentEditor.tsx'
import { keptDrafts } from '../src/views/drafts.ts'
import { Tabs } from '../src/views/Page.tsx'
import { Providers } from './memoryScreen.tsx'
import { hardwareBack, nativeLog } from './render/react-native.tsx'

// Focus after each step of the editor (web parity, cb9caeb): what took the
// place of the control the owner pressed, or of the step system back left.
// The shipped DocumentEditor, on a destination that may be hidden, beside
// controls elsewhere on screen: a button, a list's row, the bottom navigation
// and a page's tabs.
// memoryScreen.tsx's hooks clean up after each test.

const client = {
  call: () => Promise.reject(new Error('no calls here')),
  subscribe: () => () => undefined,
} as unknown as CindlClientApi

const doc = (content: string, version: string): VersionedDocument => ({
  key: 'SOUL.md',
  content,
  version: version.repeat(64).slice(0, 64),
  readAt: '2026-06-01T08:00:00.000Z',
  source: 'synthetic',
})
const READ = doc('A calm, direct voice.', 'a')
const SAVED = doc('A calm, direct voice, and brief.', 'b')

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  keptDrafts.clear()
})

type Props = Partial<ComponentProps<typeof DocumentEditor>> & {
  /** The editor's destination is the one shown (AppShell's layers). */
  shown?: boolean
}

/** The editor with a save Hermes holds until `land` or `refuse`. */
function editor() {
  let land: (saved: VersionedDocument) => void = () => undefined
  let refuse: (error: unknown) => void = () => undefined
  let saves = 0
  let now: Props = {}
  const tree = () => {
    const { shown = true, ...props } = now
    return (
      <Providers api={client}>
        <DestinationActiveProvider value={shown}>
          <DocumentEditor
            document={READ}
            label="SOUL.md"
            canWrite
            onSave={() => {
              saves += 1
              return new Promise<VersionedDocument>((resolve, reject) => {
                land = resolve
                refuse = reject
              })
            }}
            onReload={() => undefined}
            {...props}
          />
        </DestinationActiveProvider>
        <Button label="Elsewhere" onPress={() => undefined} />
        <Row
          title="calendar-triage"
          accessibilityLabel="calendar-triage"
          onPress={() => undefined}
        />
        <BottomNav current="agent" workCount={0} onSelect={() => undefined} />
        <Tabs
          label="Agent sections"
          items={[
            { id: 'identity', label: 'Identity' },
            { id: 'device', label: 'This device' },
          ]}
          current="identity"
          onSelect={() => undefined}
        />
      </Providers>
    )
  }
  const view = render(tree())
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
  /** Hermes answers the save; the next stage renders as this act ends, its focus in the settle. */
  const answer = async (reply: () => void) => {
    await act(async () => {
      reply()
      await vi.advanceTimersByTimeAsync(100)
    })
    await settle()
  }
  let seen = nativeLog.length
  const name = (node: unknown) =>
    node instanceof HTMLElement
      ? (node.getAttribute('aria-label') ?? node.textContent ?? '')
      : String(node)
  return {
    async press(label: string, role = 'button') {
      const target = [
        ...view.container.querySelectorAll<HTMLElement>(`[role="${role}"]`),
      ].find((element) => element.getAttribute('aria-label') === label)
      if (!target) throw new Error(`no ${role} ${label}`)
      fireEvent.click(target)
      await settle()
    },
    /** How many saves the editor asked Hermes for. */
    saves: () => saves,
    /** A tab's selected state as TalkBack is given it. */
    selected: (label: string) =>
      [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((element) => element.getAttribute('aria-label') === label)
        ?.getAttribute('aria-selected'),
    /** Alerts on screen (a refusal, a lock), by their text. */
    alerts: () =>
      [...view.container.querySelectorAll('[role="alert"]')].map(
        (element) => element.textContent ?? '',
      ),
    disabled: (label: string) =>
      [...view.container.querySelectorAll<HTMLElement>('[role="button"]')]
        .find((element) => element.getAttribute('aria-label') === label)
        ?.getAttribute('aria-disabled') === 'true',
    async change(text: string) {
      const box = view.container.querySelector('textarea')
      if (!box) throw new Error('no draft box')
      fireEvent.change(box, { target: { value: text } })
      await settle()
    },
    async back() {
      act(() => void hardwareBack())
      await settle()
    },
    async rerender(more: Props) {
      now = { ...now, ...more }
      view.rerender(tree())
      await settle()
    },
    land: (saved: VersionedDocument) => answer(() => land(saved)),
    refuse: (error: unknown) => answer(() => refuse(error)),
    /** Where TalkBack focus and a keyboard's were sent since the last call. */
    sent() {
      const entries = nativeLog.slice(seen)
      seen = nativeLog.length
      return {
        talkBack: entries.flatMap((entry) =>
          entry.kind === 'focus' ? [name(entry.node)] : [],
        ),
        keyboard: entries.flatMap((entry) =>
          entry.kind === 'keyboard-focus' ? [name(entry.node)] : [],
        ),
      }
    },
  }
}

type Editor = ReturnType<typeof editor>

/** Edit, a change, Review, Confirm: the save is on its way. */
async function saving() {
  const e = editor()
  await e.press('Edit')
  await e.change(SAVED.content)
  await e.press('Review changes')
  await e.press('Confirm and save')
  e.sent()
  return e
}

describe('a save gives focus to Edit once it lands', () => {
  it('when the owner pressed nothing else meanwhile', async () => {
    const e = await saving()
    await e.land(SAVED)
    expect(e.sent()).toEqual({ talkBack: ['Edit'], keyboard: ['Edit'] })
  })

  it('but not once the owner pressed something else: focus stays where they moved it', async () => {
    const e = await saving()
    await e.press('Elsewhere')
    await e.land(SAVED)
    expect(e.sent()).toEqual({ talkBack: [], keyboard: [] })
  })

  // Review 1b8252ea, S1 (its P1): a move that is no Button's press counts too.
  it.each([
    ['a tab of the bottom navigation', (e: Editor) => e.press('Work', 'tab')],
    // Review 3f7a8a69 (its R1): a list's row is a control too.
    ['a row of a list', (e: Editor) => e.press('calendar-triage')],
    ["a tab of the page's sections", (e: Editor) => e.press('This device', 'tab')],
    ['system back', (e: Editor) => e.back()],
  ])('nor once the owner moved with %s', async (_, move) => {
    const e = await saving()
    await move(e)
    await e.land(SAVED)
    expect(e.sent()).toEqual({ talkBack: [], keyboard: [] })
  })

  // Review 1b8252ea, S1 (its P2): hidden, the editor's controls take no
  // keyboard focus, and the focus module would climb out to the screen shown.
  it('nor when its destination is no longer the one shown', async () => {
    const e = await saving()
    await e.rerender({ shown: false })
    await e.land(SAVED)
    expect(e.sent()).toEqual({ talkBack: [], keyboard: [] })
  })
})

describe('a lock while the destination is hidden (review 3f7a8a69, R4)', () => {
  it('sends TalkBack focus nowhere: its screen is not the one TalkBack is on', async () => {
    const e = editor()
    await e.press('Edit')
    await e.change(SAVED.content)
    await e.rerender({ shown: false })
    e.sent()
    await e.rerender({ locked: 'SOUL.md was replaced elsewhere. Your draft is kept.' })
    expect(e.sent().talkBack).toEqual([])
  })
})

describe('what Press passes on to the Pressable (review 3f7a8a69)', () => {
  it('disabled: a second press while the save is out asks for no second save', async () => {
    const e = editor()
    await e.press('Edit')
    await e.change(SAVED.content)
    await e.press('Review changes')
    await e.press('Confirm and save')
    // While it is out, the same button reads "Saving…" and is disabled.
    expect(e.disabled('Saving…')).toBe(true)
    await e.press('Saving…')
    expect(e.saves()).toBe(1)
  })

  it('its state: the tab shown is selected, the others not', () => {
    const e = editor()
    expect([e.selected('Agent'), e.selected('Work'), e.selected('Identity')]).toEqual([
      'true',
      'false',
      'true',
    ])
  })
})

describe('"Discard the draft" (review 1b8252ea, S2)', () => {
  it('gives focus to Edit, which takes the place of the offer it removes (web parity, e395d03)', async () => {
    const e = editor()
    // A kept draft the editor does not hold is offered beside the text read.
    keptDrafts.set('SOUL.md', 'A kept draft of the voice.')
    await e.rerender({})
    e.sent()
    await e.press('Discard the draft')
    expect(keptDrafts.has('SOUL.md')).toBe(false)
    expect(e.sent()).toEqual({ talkBack: ['Edit'], keyboard: ['Edit'] })
  })
})

describe('a stale refusal ends with a discard (review 1b8252ea, S4)', () => {
  /**
   * A save refused as stale, after one that landed (so the text it replaced
   * can be restored), then back to the draft: the refusal is still set.
   */
  async function refusedAfterASave() {
    const e = await saving()
    await e.land(SAVED)
    await e.rerender({ document: SAVED })
    await e.press('Edit')
    await e.change('A calm voice, and briefer still.')
    await e.press('Review changes')
    await e.press('Confirm and save')
    await e.refuse(new CindlError('conflict', 'SOUL.md changed since you read it.'))
    expect(e.alerts()).toEqual(['SOUL.md changed since you read it. Your draft is kept.'])
    expect(e.disabled('Confirm and save')).toBe(true)
    await e.press('Back to editing')
    return e
  }

  // Review 3f7a8a69 (its R2): system back from a draft that changes nothing
  // leaves editing without a discard, so Restore clears the refusal itself.
  it('Restore previous version clears it after back from an unchanged draft', async () => {
    const e = await refusedAfterASave()
    await e.change(SAVED.content)
    await e.back()
    await e.press('Restore previous version')
    await e.press('Review changes')
    expect(e.alerts()).toEqual([])
    expect(e.disabled('Confirm and save')).toBe(false)
  })

  // Restore previous version leads to a review without passing Edit, which
  // would clear the refusal itself; the review reached that way shows none.
  it.each([
    ['Discard changes', (e: Editor) => e.press('Discard changes')],
    [
      "the discard dialog's Discard",
      async (e: Editor) => {
        await e.back()
        await e.press('Discard')
      },
    ],
  ])(
    '%s clears it, so a review reached through Restore previous version shows none',
    async (_, discard) => {
      const e = await refusedAfterASave()
      await discard(e)
      await e.press('Restore previous version')
      await e.press('Review changes')
      expect(e.alerts()).toEqual([])
      expect(e.disabled('Confirm and save')).toBe(false)
    },
  )
})

describe('the steps out of a review and back to the text', () => {
  it('"Reload and keep my draft" after a conflict gives focus to the draft', async () => {
    const e = await saving()
    await e.refuse(new CindlError('conflict', 'SOUL.md changed since you read it.'))
    expect(e.sent().talkBack).toEqual([])
    await e.press('Reload and keep my draft')
    expect(e.sent().talkBack).toEqual(['Edit SOUL.md'])
  })

  it('"Restore previous version" gives focus to the draft it restores', async () => {
    const e = await saving()
    await e.land(SAVED)
    // The screen reads the saved version again: the text it replaced is restorable.
    await e.rerender({ document: SAVED })
    e.sent()
    await e.press('Restore previous version')
    expect(e.sent()).toEqual({ talkBack: ['Edit SOUL.md'], keyboard: ['Edit SOUL.md'] })
  })

  it('system back from the review gives focus to the draft, and from an unchanged draft to Edit', async () => {
    const e = editor()
    await e.press('Edit')
    await e.change(SAVED.content)
    await e.press('Review changes')
    e.sent()
    await e.back()
    expect(e.sent().talkBack).toEqual(['Edit SOUL.md'])
    await e.change(READ.content)
    await e.back()
    expect(e.sent().talkBack).toEqual(['Edit'])
  })
})

describe('where a step lands when its usual target is not there', () => {
  it('on the lock notice while the editor is locked', async () => {
    const e = editor()
    await e.press('Edit')
    await e.change(SAVED.content)
    e.sent()
    await e.rerender({ locked: 'SOUL.md was replaced elsewhere. Your draft is kept.' })
    // The lock moves focus to its notice as it starts.
    expect(e.sent().talkBack).toEqual([
      'SOUL.md was replaced elsewhere. Your draft is kept.',
    ])
    await e.press('Discard changes')
    expect(e.sent().talkBack).toEqual([
      'SOUL.md was replaced elsewhere. Your draft is kept.',
    ])
  })

  it('on Reload when there is no Edit', async () => {
    const e = editor()
    await e.press('Edit')
    await e.change(SAVED.content)
    // Writing is no longer offered (capabilities changed) while the draft is open.
    await e.rerender({ canWrite: false })
    e.sent()
    await e.press('Discard changes')
    expect(e.sent().talkBack).toEqual(['Reload'])
  })
})
