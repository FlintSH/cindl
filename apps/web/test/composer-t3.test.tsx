import { CindlProvider } from '@cindl/client-react'
import type { CapabilityMap, CindlClientApi, CindlEvent, Message } from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../src/talk/Composer.tsx'
import { forgetPlaces } from '../src/talk/places.ts'

afterEach(() => {
  cleanup()
  forgetPlaces()
  vi.restoreAllMocks()
})

const said = (id: string, text: string): Message => ({
  id,
  conversationId: 'c1',
  role: 'user',
  parts: [{ type: 'text', text }],
  status: 'complete',
})

/** An online client that can send and stop, with what the owner sent in c1. */
async function renderComposer(running: boolean) {
  const capabilities: CapabilityMap = {}
  for (const id of ['chat.stream', 'chat.interrupt'] as const)
    capabilities[id] = { id, state: 'available', source: { transport: 'none' } }
  const calls: string[] = []
  const api: CindlClientApi = {
    call: (name) => {
      calls.push(name)
      return new Promise(() => undefined)
    },
    subscribe(listener: (event: CindlEvent) => void) {
      queueMicrotask(() => {
        listener({
          type: 'link.changed',
          link: {
            phase: 'online',
            since: '2026-01-01T00:00:00.000Z',
            connectionEpoch: 1,
          },
        })
        listener({ type: 'capabilities.changed', capabilities })
        listener({
          type: 'history.loaded',
          conversationId: 'c1',
          messages: [said('m1', 'First ask'), said('m2', 'Second ask')],
        })
      })
      return () => undefined
    },
  }
  render(
    <CindlProvider api={api}>
      <Composer
        conversationId="c1"
        canStop={running}
        hint={undefined}
        agentName="Hermes"
      />
    </CindlProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return { calls, box: screen.getByRole<HTMLTextAreaElement>('textbox') }
}

describe('the composer, after T3 Code', () => {
  it('offers Stop in its one primary slot while Hermes works and the box is empty, and Send once there is text', async () => {
    const { box } = await renderComposer(true)
    expect(screen.getByRole('button', { name: 'Stop the current turn' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    fireEvent.change(box, { target: { value: 'Also check the kiln' } })
    expect(screen.queryByRole('button', { name: 'Stop the current turn' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('brings back what you sent with ArrowUp in an empty box, and goes forward with ArrowDown', async () => {
    const { box } = await renderComposer(false)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('Second ask')
    box.setSelectionRange(0, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('First ask')
    box.setSelectionRange(box.value.length, box.value.length)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.value).toBe('Second ask')
    box.setSelectionRange(box.value.length, box.value.length)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.value).toBe('')
  })

  it('leaves the arrow keys alone once the text is your own', async () => {
    const { box } = await renderComposer(false)
    fireEvent.change(box, { target: { value: 'Draft' } })
    box.setSelectionRange(0, 0)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(box.value).toBe('Draft')
  })

  it('never takes the second click of a double click on Send as Stop, and keeps focus in the text', async () => {
    const { box, calls } = await renderComposer(true)
    fireEvent.change(box, { target: { value: 'Steer toward the kiln' } })
    const send = screen.getByRole('button', { name: 'Send' })
    send.focus()
    fireEvent.click(send, { detail: 1 })
    expect(calls).toEqual(['prompt.submit'])
    // Sent from the button, focus is back in the text, not on the Stop that took its place.
    expect(document.activeElement).toBe(box)
    const stop = screen.getByRole('button', { name: 'Stop the current turn' })
    expect(stop).not.toBe(send)
    fireEvent.click(stop, { detail: 2 })
    // A single click right after Stop appears is not a stop either.
    fireEvent.click(stop, { detail: 1 })
    expect(calls).toEqual(['prompt.submit'])
    // A moment later it is.
    const later = performance.now() + 600
    vi.spyOn(performance, 'now').mockReturnValue(later)
    fireEvent.click(stop, { detail: 1 })
    expect(calls).toEqual(['prompt.submit', 'conversation.interrupt'])
  })
})
