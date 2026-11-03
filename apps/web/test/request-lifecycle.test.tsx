import type { ConversationActivity } from '@cindl/client-core'
import { CindlProvider, useOpenRequests } from '@cindl/client-react'
import {
  parseOpArgs,
  type CindlClientApi,
  type CindlEvent,
  type LinkState,
  type ServerRequest,
} from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from '../src/talk/Composer.tsx'
import { composerHint, presenceCopy } from '../src/talk/presence.ts'
import { RequestCard } from '../src/talk/RequestCard.tsx'

afterEach(cleanup)

const approval: ServerRequest = {
  requestId: 'srq-0000000000b1',
  lastSeenEpoch: 1,
  kind: 'approval',
  conversationId: 'c1',
  title: 'Run the export',
  command: 'python3 export.py',
  choices: ['once', 'deny'],
  receivedAt: '2026-01-01T00:00:00.000Z',
  status: 'open',
}
const sudo: ServerRequest = {
  requestId: 'srq-0000000000b2',
  lastSeenEpoch: 1,
  kind: 'unsupported',
  unsupportedKind: 'sudo',
  conversationId: 'c1',
  title: 'sudo password to restart a service',
  choices: [],
  receivedAt: '2026-01-01T00:00:00.000Z',
  status: 'open',
}
const online: LinkState = {
  phase: 'online',
  since: '2026-01-01T00:00:00.000Z',
  connectionEpoch: 1,
}

/**
 * A client that behaves like the real implementations: it validates with
 * parseOpArgs, marks an answer as answering before it resolves, and lets the
 * test emit later events (Hermes acknowledging, or the send failing).
 */
function liveClient(requests: ServerRequest[]) {
  const calls: Array<{ name: string; args: unknown }> = []
  let emit: (event: CindlEvent) => void = () => undefined
  const api: CindlClientApi = {
    call: (name, args) => {
      try {
        parseOpArgs(name, args)
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
      calls.push({ name, args })
      if (name === 'request.answer') {
        const { requestId, answer } = args as { requestId: string; answer: never }
        const request = requests.find((r) => r.requestId === requestId)
        const answering = { ...request, status: 'answering', answer } as ServerRequest
        emit({ type: 'request.opened', request: answering })
        return Promise.resolve(answering as never)
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    },
    subscribe(listener) {
      emit = listener
      queueMicrotask(() => {
        listener({ type: 'link.changed', link: online })
        for (const request of requests) listener({ type: 'request.opened', request })
      })
      return () => undefined
    },
  }
  return {
    api,
    calls,
    emit: (event: CindlEvent) =>
      act(async () => {
        emit(event)
        await Promise.resolve()
      }),
  }
}

function OpenCards() {
  return (
    <>
      {useOpenRequests().map((request) => (
        <RequestCard key={request.requestId} request={request} />
      ))}
    </>
  )
}

const settle = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

describe('decision card follows the request lifecycle in the store', () => {
  it('unlocks again when the answer fails after the call returned', async () => {
    const client = liveClient([approval])
    render(
      <CindlProvider api={client.api}>
        <OpenCards />
      </CindlProvider>,
    )
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await settle()
    expect(screen.getByText('Sending your answer…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', true)

    await client.emit({ type: 'request.answer-failed', requestId: approval.requestId })
    expect(screen.queryByText('Sending your answer…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', false)

    // It can be answered again; this time Hermes acknowledges and the card goes.
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await settle()
    await client.emit({
      type: 'request.closed',
      requestId: approval.requestId,
      status: 'answered',
    })
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    expect(client.calls.filter((c) => c.name === 'request.answer')).toHaveLength(2)
  })
})

describe('prompts Cindl does not answer', () => {
  it('shows what Hermes waits for and offers nothing to send', async () => {
    const client = liveClient([sudo])
    render(
      <CindlProvider api={client.api}>
        <OpenCards />
      </CindlProvider>,
    )
    await settle()
    expect(screen.getByRole('heading', { name: /sudo password to restart/ })).toBeTruthy()
    expect(screen.getByText(/Hermes is waiting for a sudo password/)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(client.calls).toEqual([])
  })

  it('counts them as waiting on the owner, outside Cindl', () => {
    const activity: ConversationActivity = {
      phase: 'waiting-on-you',
      openRequests: [sudo],
      executingTools: [],
      blockedToolIds: new Set(),
      queuedPrompts: 0,
      turnOpen: true,
      otherExecuting: 0,
    }
    expect(presenceCopy(online, activity).text).toBe(
      'Waiting on you: 1 prompt outside Cindl',
    )
    expect(composerHint(activity)).toMatch(/outside Cindl/)
    expect(
      presenceCopy(online, { ...activity, openRequests: [approval, sudo] }).text,
    ).toBe('Waiting on you: 1 approval, 1 prompt outside Cindl')
  })
})

describe('composer reports validation failures as not sent', () => {
  it('keeps an over-long message and says it was not sent', async () => {
    const client = liveClient([])
    render(
      <CindlProvider api={client.api}>
        <Composer
          conversationId="c1"
          canStop={false}
          hint={undefined}
          agentName="Hermes"
        />
      </CindlProvider>,
    )
    await settle()
    await client.emit({
      type: 'capabilities.changed',
      capabilities: {
        'chat.stream': {
          id: 'chat.stream',
          state: 'available',
          source: { transport: 'none' },
        },
      },
    })
    const box = screen.getByRole('textbox')
    const long = 'x'.repeat(100_001)
    fireEvent.change(box, { target: { value: long } })
    fireEvent.submit(box.closest('form') as HTMLFormElement)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(
      'Not sent: the text is longer than 100,000 characters.',
    )
    expect((box as HTMLTextAreaElement).value).toBe(long)
    expect(client.calls).toEqual([])
  })
})
