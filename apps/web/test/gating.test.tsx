import { CindlProvider } from '@cindl/client-react'
import type {
  CapabilityId,
  CapabilityMap,
  CindlClientApi,
  CindlEvent,
} from '@cindl/contracts'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from '../src/talk/Composer.tsx'

afterEach(cleanup)

/** Minimal in-test client: an online link and exactly the given capabilities. */
function testApi(usable: CapabilityId[]): CindlClientApi & { calls: string[] } {
  const calls: string[] = []
  const capabilities: CapabilityMap = {}
  for (const id of usable)
    capabilities[id] = { id, state: 'available', source: { transport: 'none' } }
  return {
    calls,
    call: (name) => {
      calls.push(name)
      return Promise.reject(new Error(`unexpected call ${name}`))
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
      })
      return () => undefined
    },
  }
}

async function renderComposer(usable: CapabilityId[], canStop = true) {
  const api = testApi(usable)
  render(
    <CindlProvider api={api}>
      <Composer
        conversationId="c1"
        canStop={canStop}
        hint={undefined}
        agentName="Hermes"
      />
    </CindlProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return api
}

describe('composer follows negotiated capabilities', () => {
  it('cannot send when chat.stream is not usable, and says why', async () => {
    await renderComposer(['chat.interrupt'])
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message Hermes',
    })
    expect(box.disabled).toBe(true)
    expect(box.getAttribute('placeholder')).toBe(
      'Sending is not available on this connection.',
    )
  })

  it('offers Stop only when chat.interrupt is usable', async () => {
    await renderComposer(['chat.stream'])
    expect(screen.queryByRole('button', { name: 'Stop the current turn' })).toBeNull()
    cleanup()
    await renderComposer(['chat.stream', 'chat.interrupt'])
    expect(screen.getByRole('button', { name: 'Stop the current turn' })).toBeTruthy()
  })

  it('sends nothing on its own while capabilities are unknown', async () => {
    const api = await renderComposer([])
    expect(api.calls).toEqual([])
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' })
        .disabled,
    ).toBe(true)
  })
})
