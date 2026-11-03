/** @vitest-environment jsdom */
import type { CindlClientApi } from '@cindl/contracts'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { Text, type HostInstance } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBackHandler } from '../src/nav/NavProvider.tsx'
import { claimFocus, FocusFallback } from '../src/overlay/opener.ts'
import { BehindOverlays } from '../src/overlay/Portal.tsx'
import { Dialog, Sheet } from '../src/overlay/Sheet.tsx'
import { Button, Txt } from '../src/ui/primitives.tsx'
import { harness, openEntry, Providers } from './memoryScreen.tsx'
import { hardwareBack, nativeLog, resetNative } from './render/react-native.tsx'

// Every dialog and sheet is the shipped Dialog or Sheet (src/overlay/Sheet.tsx)
// in the PortalHost, beside what AppShell's BehindOverlays holds. TalkBack
// focus and a hardware keyboard's (modules/cindl-focus, recorded by
// test/render/expo.ts) move into an overlay as it opens and back as it
// closes; what it covers is hidden from TalkBack and closed to the keyboard.

const client = {
  call: () => Promise.reject(new Error('no calls here')),
  subscribe: () => () => undefined,
} as unknown as CindlClientApi

let errors: unknown[] = []
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  errors = []
  vi.spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => void errors.push(args),
  )
  resetNative()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  expect(errors).toEqual([])
})

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })

/** A screen with a heading (its focus fallback) and a control that opens an overlay. */
function Screen({ kind, opener = true }: { kind: 'dialog' | 'sheet'; opener?: boolean }) {
  const heading = useRef<HostInstance | null>(null)
  const nearer = useRef<HostInstance | null>(null)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(true)
  const [nearerShown, setNearerShown] = useState(true)
  // Without an opener, system back opens it, as it opens the editor's discard dialog.
  useBackHandler(() => {
    setOpen(true)
    return true
  }, !opener && !open)
  const close = (also?: () => void) => () => {
    setOpen(false)
    also?.()
  }
  const content = (
    <>
      <Txt>The body.</Txt>
      <Button label="Done" onPress={close()} />
      <Button label="Done, and the opener goes" onPress={close(() => setShown(false))} />
      <Button
        label="Done, and both go"
        onPress={close(() => {
          setShown(false)
          setNearerShown(false)
        })}
      />
      <Button label="Show it elsewhere" onPress={close(() => claimFocus())} />
    </>
  )
  return (
    <FocusFallback value={() => heading.current}>
      <Text ref={heading} accessibilityRole="header">
        Library
      </Text>
      {nearerShown ? (
        <Button ref={nearer} label="Nearer" onPress={() => undefined} />
      ) : null}
      {shown && opener ? <Button label="Open it" onPress={() => setOpen(true)} /> : null}
      {kind === 'dialog' ? (
        <Dialog
          open={open}
          title="Change it?"
          onCancel={close()}
          returnFocus={() => nearer.current}
          actions={content}
        />
      ) : (
        <Sheet
          open={open}
          title="Details"
          onClose={close()}
          returnFocus={() => nearer.current}
        >
          {content}
        </Sheet>
      )}
    </FocusFallback>
  )
}

function mount(kind: 'dialog' | 'sheet', opener = true) {
  const view = render(
    <Providers api={client}>
      <div data-screen="">
        <BehindOverlays>
          <Screen kind={kind} opener={opener} />
        </BehindOverlays>
      </div>
    </Providers>,
  )
  const screen = () => view.container.querySelector('[data-screen]') as HTMLElement
  const behind = () => screen().firstElementChild as HTMLElement
  const byName = (name: string) =>
    [...view.container.querySelectorAll<HTMLElement>('[role="button"]')].find(
      (element) => element.getAttribute('aria-label') === name,
    )
  const name = (node: unknown) => {
    if (!(node instanceof HTMLElement)) return String(node)
    if (node === behind()) return 'background'
    const role = node.getAttribute('role')
    if (role === 'button') return `button: ${node.getAttribute('aria-label')}`
    if (role === 'heading')
      return screen().contains(node)
        ? `heading: ${node.textContent}`
        : `title: ${node.textContent}`
    if (!screen().contains(node) && node.querySelector('[role="heading"]')) return 'frame'
    return node.textContent ?? ''
  }
  return {
    press: async (label: string) => {
      const target = byName(label)
      if (!target) throw new Error(`no button ${label}`)
      fireEvent.click(target)
      await settle()
    },
    back: async () => {
      act(() => void hardwareBack())
      await settle()
    },
    settle,
    hidden: () => behind().getAttribute('aria-hidden') === 'true',
    talkback: () => nativeLog.flatMap((e) => (e.kind === 'focus' ? [name(e.node)] : [])),
    keyboard: () =>
      nativeLog.flatMap((e) =>
        e.kind === 'keyboard-block'
          ? [`${e.blocked ? 'block' : 'unblock'} ${name(e.node)}`]
          : e.kind === 'keyboard-focus'
            ? [name(e.node)]
            : [],
      ),
  }
}

describe('a dialog or sheet takes focus as it opens and gives it back as it closes', () => {
  for (const kind of ['dialog', 'sheet'] as const)
    it(`${kind}: into its title and first control, then back to what opened it`, async () => {
      const s = mount(kind)
      await s.press('Open it')
      expect(s.hidden()).toBe(true)
      expect(s.talkback()).toEqual([
        kind === 'dialog' ? 'title: Change it?' : 'title: Details',
      ])
      expect(s.keyboard()).toEqual(['block background', 'frame'])
      await s.press('Done')
      expect(s.hidden()).toBe(false)
      expect(s.talkback().slice(1)).toEqual(['button: Open it'])
      expect(s.keyboard().slice(2)).toEqual(['unblock background', 'button: Open it'])
    })

  it('gives focus to the nearer control the overlay names when what opened it is gone', async () => {
    const s = mount('dialog')
    await s.press('Open it')
    await s.press('Done, and the opener goes')
    expect(s.talkback().slice(1)).toEqual(['button: Nearer'])
    expect(s.keyboard().slice(2)).toEqual(['unblock background', 'button: Nearer'])
  })

  it("falls back to the screen's heading when both are gone: never to nothing", async () => {
    const s = mount('sheet')
    await s.press('Open it')
    await s.press('Done, and both go')
    expect(s.talkback().slice(1)).toEqual(['heading: Library'])
    expect(s.keyboard().slice(2)).toEqual(['unblock background', 'heading: Library'])
  })

  it('opened by no control (system back opens the discard dialog), gives focus to the nearer control', async () => {
    const s = mount('dialog', false)
    await s.back()
    expect(s.hidden()).toBe(true)
    expect(s.talkback()).toEqual(['title: Change it?'])
    await s.back()
    expect(s.hidden()).toBe(false)
    expect(s.talkback().slice(1)).toEqual(['button: Nearer'])
    expect(s.keyboard().slice(2)).toEqual(['unblock background', 'button: Nearer'])
  })

  it('gives none back when the action that closed it moved focus itself', async () => {
    const s = mount('sheet')
    await s.press('Open it')
    await s.press('Show it elsewhere')
    expect(s.talkback()).toEqual(['title: Details'])
    expect(s.keyboard()).toEqual(['block background', 'frame', 'unblock background'])
  })
})

describe('the memory screen behind its dialogs', () => {
  it('hides the screen while the delete warning is open, and gives focus back to "Delete entry…"', async () => {
    const h = harness(undefined, { inSection: true })
    await openEntry(h, /Glaze/)
    h.press('Delete entry…')
    await h.settle()
    expect(h.behindHidden()).toBe(true)
    expect(h.focusLog().at(-1)).toBe('dialog: Delete this memory entry?')
    expect(h.keyboardLog().slice(-2)).toEqual([
      'block background',
      'frame: Delete this memory entry?',
    ])
    h.press('Keep it')
    await h.settle()
    expect(h.behindHidden()).toBe(false)
    expect(h.focusLog().at(-1)).toBe('button: Delete entry…')
    expect(h.keyboardLog().slice(-2)).toEqual([
      'unblock background',
      'button: Delete entry…',
    ])
  })

  it("has a scrim that takes a tap but no keyboard's focus, told apart by its id (delta check of 7dab9fe, B1)", async () => {
    const h = harness(undefined, { inSection: true })
    await openEntry(h, /Glaze/)
    h.press('Delete entry…')
    await h.settle()
    // The id is what a device dump reports as the node's resource-id (e2e/ui.ts scrimOf).
    const scrim = h.scrim()
    expect(scrim?.getAttribute('data-testid')).toBe('cindl-scrim')
    // CI run 41712256173: Tab went to the scrim first, before "Keep it".
    expect(scrim?.getAttribute('data-focusable')).toBe('false')
    h.pressScrim()
    await h.settle()
    expect(h.dialog('Delete this memory entry?')).toBeUndefined()
    expect(h.scrim()).toBeUndefined()
  })

  it('gives focus to the Entries heading once the entry is deleted (its editor is gone)', async () => {
    const h = harness(undefined, { inSection: true })
    await openEntry(h, /Glaze/)
    h.press('Delete entry…')
    await h.settle()
    h.press('Delete permanently')
    await h.settle()
    expect(h.button(/Open memory entry: Glaze/)).toBeUndefined()
    expect(h.focusLog().at(-1)).toBe('heading: Entries')
    expect(h.keyboardLog().at(-1)).toBe('heading: Entries')
  })

  it('gives focus back to the draft, or to Edit once the draft is discarded (back opens it)', async () => {
    const h = harness(undefined, { inSection: true })
    await openEntry(h, /Glaze/)
    h.press('Edit')
    h.change('A changed glaze note.')
    await h.settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    h.back()
    await h.settle()
    expect(h.behindHidden()).toBe(true)
    expect(h.focusLog().at(-1)).toBe('dialog: Discard your changes?')
    h.press('Keep editing')
    await h.settle()
    expect(h.focusLog().at(-1)).toBe('draft')
    h.back()
    await h.settle()
    h.press('Discard')
    await h.settle()
    expect(h.focusLog().at(-1)).toBe('button: Edit')
    expect(h.keyboardLog().at(-1)).toBe('button: Edit')
  })
})
