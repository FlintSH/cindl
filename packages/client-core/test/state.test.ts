import type { CindlEvent, LinkState, ServerRequest } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  createStore,
  reduce,
  initialState,
  requestKey,
  selectOpenRequests,
} from '../src/index.ts'

const link: LinkState = {
  phase: 'online',
  since: '2026-01-01T00:00:00.000Z',
  connectionEpoch: 1,
}
const run = (events: CindlEvent[]) => events.reduce(reduce, initialState(link))

const approval = (overrides: Partial<ServerRequest> = {}): ServerRequest => ({
  rpcId: 'r-1',
  connectionEpoch: 1,
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
  it('keys requests by connection epoch so a reused rpc id cannot collide', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.opened', request: approval({ connectionEpoch: 2 }) },
    ])
    expect(Object.keys(state.requests)).toEqual([
      requestKey('r-1', 1),
      requestKey('r-1', 2),
    ])
  })

  it('does not reopen a request that was already answered when a frame is replayed', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      {
        type: 'request.opened',
        request: approval({
          status: 'answered',
          answer: { kind: 'approval', choice: 'deny' },
        }),
      },
      { type: 'request.opened', request: approval() },
    ])
    expect(state.requests[requestKey('r-1', 1)]?.status).toBe('answered')
    expect(selectOpenRequests(state)).toHaveLength(0)
  })

  it('closes cancelled requests and never reopens them', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.closed', rpcId: 'r-1', status: 'cancelled' },
      { type: 'request.opened', request: approval() },
    ])
    expect(state.requests[requestKey('r-1', 1)]?.status).toBe('cancelled')
  })
})

describe('store', () => {
  it('notifies only on change', () => {
    const store = createStore(link)
    let calls = 0
    store.subscribe(() => calls++)
    store.dispatch({ type: 'request.closed', rpcId: 'missing', status: 'cancelled' })
    store.dispatch({ type: 'notice', level: 'info', message: 'Synthetic notice' })
    expect(calls).toBe(1)
  })
})
