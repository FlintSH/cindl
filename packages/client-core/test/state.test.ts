import type { CindlEvent, LinkState, ServerRequest } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { createStore, reduce, initialState, selectOpenRequests } from '../src/index.ts'

const link: LinkState = {
  phase: 'online',
  since: '2026-01-01T00:00:00.000Z',
  connectionEpoch: 1,
}
const run = (events: CindlEvent[]) => events.reduce(reduce, initialState(link))

const approval = (overrides: Partial<ServerRequest> = {}): ServerRequest => ({
  requestId: 'srq-00000000000a',
  lastSeenEpoch: 1,
  kind: 'approval',
  conversationId: 'c1',
  title: 'Run a command',
  command: 'ls fixtures/',
  choices: ['once', 'deny'],
  receivedAt: '2026-01-01T00:00:01.000Z',
  status: 'open',
  ...overrides,
})

describe('streaming messages', () => {
  it('assembles deltas into text and reasoning parts in order', () => {
    const state = run([
      {
        type: 'message.started',
        conversationId: 'c1',
        messageId: 'm1',
        role: 'assistant',
      },
      {
        type: 'message.delta',
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'reasoning',
        text: 'Think',
      },
      {
        type: 'message.delta',
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'text',
        text: 'Hel',
      },
      {
        type: 'message.delta',
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'text',
        text: 'lo',
      },
      {
        type: 'message.completed',
        conversationId: 'c1',
        messageId: 'm1',
        status: 'complete',
      },
    ])
    expect(state.messages.c1).toEqual([
      expect.objectContaining({
        status: 'complete',
        parts: [
          { type: 'reasoning', text: 'Think' },
          { type: 'text', text: 'Hello' },
        ],
      }),
    ])
  })

  it('prefers the authoritative final text over streamed deltas', () => {
    const state = run([
      {
        type: 'message.delta',
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'text',
        text: 'Hel',
      },
      {
        type: 'message.completed',
        conversationId: 'c1',
        messageId: 'm1',
        status: 'complete',
        text: 'Hello.',
      },
    ])
    expect(state.messages.c1?.[0]?.parts).toEqual([{ type: 'text', text: 'Hello.' }])
  })

  it('anchors tool activity inside the streaming assistant message once', () => {
    const tool = {
      id: 't1',
      conversationId: 'c1',
      name: 'terminal',
      title: 'List files',
      status: 'running' as const,
    }
    const state = run([
      {
        type: 'message.started',
        conversationId: 'c1',
        messageId: 'm1',
        role: 'assistant',
      },
      { type: 'tool.updated', activity: tool },
      { type: 'tool.updated', activity: { ...tool, status: 'complete' } },
    ])
    expect(state.messages.c1?.[0]?.parts).toEqual([{ type: 'tool', toolId: 't1' }])
    expect(state.tools.t1?.status).toBe('complete')
  })

  it('does not anchor a tool twice when history already places it', () => {
    const tool = {
      id: 't-old',
      conversationId: 'c1',
      name: 'calendar.search',
      title: 'Checked a calendar',
      status: 'complete' as const,
    }
    const state = run([
      {
        type: 'history.loaded',
        conversationId: 'c1',
        messages: [
          {
            id: 'm-old',
            conversationId: 'c1',
            role: 'assistant',
            parts: [{ type: 'tool', toolId: 't-old' }],
            status: 'complete',
          },
          {
            id: 'm-live',
            conversationId: 'c1',
            role: 'assistant',
            parts: [],
            status: 'streaming',
          },
        ],
      },
      { type: 'tool.updated', activity: tool },
    ])
    const references = (state.messages.c1 ?? []).flatMap((m) =>
      m.parts.filter((p) => p.type === 'tool' && p.toolId === 't-old'),
    )
    expect(references).toHaveLength(1)
    expect(state.messages.c1?.[1]?.parts).toEqual([])
  })

  it('drops a conversation transcript on history reset so it is refetched', () => {
    const state = run([
      {
        type: 'message.started',
        conversationId: 'c1',
        messageId: 'm1',
        role: 'assistant',
      },
      { type: 'history.reset', conversationId: 'c1', reason: 'epoch-changed' },
    ])
    expect(state.messages.c1).toBeUndefined()
  })
})

describe('server requests', () => {
  const id = 'srq-00000000000a'

  it('treats a re-sent frame after reconnect as the same request, not a second card', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
    ])
    expect(Object.keys(state.requests)).toEqual([id])
    expect(state.requests[id]?.lastSeenEpoch).toBe(2)
    expect(selectOpenRequests(state)).toHaveLength(1)
  })

  it('keeps an in-flight answer when the request is re-sent', () => {
    const answer = { kind: 'approval' as const, choice: 'deny' as const }
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.opened', request: approval({ status: 'answering', answer }) },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
    ])
    expect(state.requests[id]).toMatchObject({
      status: 'answering',
      answer,
      lastSeenEpoch: 2,
    })
  })

  it('does not reopen a request that was already answered when a frame is replayed', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.closed', requestId: id, status: 'answered' },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
    ])
    expect(state.requests[id]?.status).toBe('answered')
    expect(selectOpenRequests(state)).toHaveLength(0)
  })

  it('closes requests Hermes no longer holds open after a reconnect', () => {
    const other = 'srq-00000000000b'
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.opened', request: approval({ requestId: other }) },
      { type: 'requests.synced', openRequestIds: [other] },
    ])
    expect(state.requests[id]?.status).toBe('resolved-elsewhere')
    expect(state.requests[other]?.status).toBe('open')
  })

  it('closes cancelled requests and never reopens them', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.closed', requestId: id, status: 'cancelled' },
      { type: 'request.opened', request: approval() },
    ])
    expect(state.requests[id]?.status).toBe('cancelled')
  })

  it('ignores ids it has never seen, including inherited object keys', () => {
    const state = run([
      { type: 'request.closed', requestId: 'toString', status: 'cancelled' },
    ])
    expect(state.requests).toEqual({})
  })
})

describe('message completion', () => {
  it('replaces streamed text in place so tool rows keep their position', () => {
    const tool = {
      id: 't1',
      conversationId: 'c1',
      name: 'x',
      title: 'Step',
      status: 'complete' as const,
    }
    const state = run([
      {
        type: 'message.started',
        conversationId: 'c1',
        messageId: 'm1',
        role: 'assistant',
      },
      {
        type: 'message.delta',
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'text',
        text: 'Before ',
      },
      { type: 'tool.updated', activity: tool },
      {
        type: 'message.completed',
        conversationId: 'c1',
        messageId: 'm1',
        status: 'complete',
        text: 'Before, then after.',
      },
    ])
    expect(state.messages.c1?.[0]?.parts).toEqual([
      { type: 'text', text: 'Before, then after.' },
      { type: 'tool', toolId: 't1' },
    ])
  })

  it('records a completed message it never saw start', () => {
    const state = run([
      {
        type: 'message.completed',
        conversationId: 'c1',
        messageId: 'late',
        status: 'complete',
        text: 'Joined late.',
      },
    ])
    expect(state.messages.c1?.[0]).toMatchObject({
      id: 'late',
      parts: [{ type: 'text', text: 'Joined late.' }],
    })
  })

  it('does not treat inherited keys as known tools', () => {
    const state = run([
      {
        type: 'message.started',
        conversationId: 'c1',
        messageId: 'm1',
        role: 'assistant',
      },
      {
        type: 'tool.updated',
        activity: {
          id: 'toString',
          conversationId: 'c1',
          name: 'x',
          title: 'Odd id',
          status: 'running',
        },
      },
    ])
    expect(state.messages.c1?.[0]?.parts).toEqual([{ type: 'tool', toolId: 'toString' }])
  })
})

describe('store', () => {
  it('notifies only on change', () => {
    const store = createStore(link)
    let calls = 0
    store.subscribe(() => calls++)
    store.dispatch({
      type: 'request.closed',
      requestId: 'srq-missing',
      status: 'cancelled',
    })
    store.dispatch({ type: 'notice', level: 'info', message: 'Synthetic notice' })
    expect(calls).toBe(1)
  })
})
