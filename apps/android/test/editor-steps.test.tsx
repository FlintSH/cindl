/** @vitest-environment jsdom */
import { CindlError } from '@cindl/contracts'
import type { CindlClientApi, VersionedDocument } from '@cindl/contracts'
import { act, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '../src/ui/primitives.tsx'
import { DocumentEditor } from '../src/views/DocumentEditor.tsx'
import { keptDrafts } from '../src/views/drafts.ts'
import { Providers } from './memoryScreen.tsx'
import { hardwareBack, nativeLog } from './render/react-native.tsx'

// Focus after each step of the editor (web parity, cb9caeb): what took the
// place of the control the owner pressed, or of the step system back left.
// The shipped DocumentEditor, beside a control elsewhere on screen.
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

type Props = Partial<ComponentProps<typeof DocumentEditor>>

/** The editor with a save Hermes holds until `land` or `refuse`. */
function editor() {
  let land: (saved: VersionedDocument) => void = () => undefined
  let refuse: (error: unknown) => void = () => undefined
  let now: Props = {}
  const tree = () => (
    <Providers api={client}>
      <DocumentEditor
        document={READ}
        label="SOUL.md"
        canWrite
        onSave={() =>
          new Promise<VersionedDocument>((resolve, reject) => {
            land = resolve
            refuse = reject
          })
        }
        onReload={() => undefined}
        {...now}
      />
      <Button label="Elsewhere" onPress={() => undefined} />
    </Providers>
  )
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
    async press(label: string) {
      const target = [
        ...view.container.querySelectorAll<HTMLElement>('[role="button"]'),
      ].find((element) => element.getAttribute('aria-label') === label)
      if (!target) throw new Error(`no button ${label}`)
      fireEvent.click(target)
      await settle()
    },
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
