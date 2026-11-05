/** @vitest-environment jsdom */
import type { CapabilityMap, CindlClientApi, CindlEvent } from '@cindl/contracts'
import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from '../src/talk/Composer.tsx'
import { Providers } from './memoryScreen.tsx'

describe('the composer’s primary slot, after T3 Code', () => {
  it('keeps Send while a send is pending and never treats its second tap as Stop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'))
    const capabilities: CapabilityMap = {}
    for (const id of ['chat.stream', 'chat.interrupt'] as const)
      capabilities[id] = { id, state: 'available', source: { transport: 'none' } }
    const calls: string[] = []
    let sent: (() => void) | undefined
    const api = {
      call: (name: string) => {
        calls.push(name)
        return name === 'prompt.submit'
          ? new Promise<void>((resolve) => (sent = resolve))
          : Promise.resolve({ requested: true })
      },
      subscribe: (listener: (event: CindlEvent) => void) => {
        queueMicrotask(() => {
          listener({
            type: 'link.changed',
            link: {
              phase: 'online',
              since: '2026-06-01T09:00:00.000Z',
              connectionEpoch: 1,
            },
          })
          listener({ type: 'capabilities.changed', capabilities })
        })
        return () => undefined
      },
    } as unknown as CindlClientApi
    const view = render(
      <Providers api={api}>
        <Composer
          conversationId="test-primary-slot"
          canStop
          hint={undefined}
          agentName="Hermes"
        />
      </Providers>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.change(view.getByRole('textbox', { name: 'Message Hermes' }), {
      target: { value: 'Check the kiln first (fixture)' },
    })
    fireEvent.click(view.getByRole('button', { name: 'Send' }))
    expect(calls).toEqual(['prompt.submit'])
    expect(view.queryByRole('button', { name: 'Stop the current turn' })).toBeNull()
    const sending = view.getByRole('button', { name: 'Send' })
    expect(sending.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(sending)
    expect(calls).toEqual(['prompt.submit'])

    await act(async () => {
      sent?.()
      await Promise.resolve()
    })
    const stop = view.getByRole('button', { name: 'Stop the current turn' })
    fireEvent.click(stop)
    expect(calls).toEqual(['prompt.submit'])

    // Once Stop has been visible long enough for a deliberate press, it works.
    vi.setSystemTime(new Date('2026-06-01T09:00:01.000Z'))
    await act(async () => {
      fireEvent.click(stop)
      await Promise.resolve()
    })
    expect(calls).toEqual(['prompt.submit', 'conversation.interrupt'])
  })
})
