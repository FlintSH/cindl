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
  const other = 'srq-00000000000b'
  const deny = { kind: 'approval' as const, choice: 'deny' as const }

  it('treats a re-sent frame after reconnect as the same request, not a second card', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
    ])
    expect(Object.keys(state.requests)).toEqual([id])
    expect(state.requests[id]?.lastSeenEpoch).toBe(2)
    expect(selectOpenRequests(state)).toHaveLength(1)
  })

  it('keeps an in-flight answer when the request is re-sent on the same connection', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.opened', request: approval() },
    ])
    expect(state.requests[id]).toMatchObject({ status: 'answering', answer: deny })
  })

  it('reopens an in-flight answer when a newer connection re-sends it (the answer never landed)', () => {
    const state = run([
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
    ])
    expect(state.requests[id]).toMatchObject({ status: 'open', lastSeenEpoch: 2 })
    expect(state.requests[id]?.answer).toBeUndefined()
    expect(selectOpenRequests(state)).toHaveLength(1)
  })

  it("keeps Hermes's own close status and the answer this client sent", () => {
    for (const status of ['resolved-elsewhere', 'cancelled', 'expired'] as const) {
      const state = run([
        {
          type: 'request.opened',
          request: approval({ status: 'answering', answer: deny }),
        },
        { type: 'request.closed', requestId: id, status },
      ])
      expect(state.requests[id]).toMatchObject({ status, answer: deny })
    }
  })

  it('records answered only from an acknowledgement, even one that follows a resolved broadcast', () => {
    const acknowledged = run([
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.closed', requestId: id, status: 'answered' },
    ])
    expect(acknowledged.requests[id]?.status).toBe('answered')
    const late = run([
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.closed', requestId: id, status: 'resolved-elsewhere' },
      { type: 'request.closed', requestId: id, status: 'answered' },
    ])
    expect(late.requests[id]?.status).toBe('answered')
    // Without an answer from this client there is nothing to acknowledge.
    const foreign = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.closed', requestId: id, status: 'resolved-elsewhere' },
      { type: 'request.closed', requestId: id, status: 'answered' },
    ])
    expect(foreign.requests[id]?.status).toBe('resolved-elsewhere')
  })

  it('makes a request answerable again when the answer could not be sent', () => {
    const state = run([
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.answer-failed', requestId: id },
    ])
    expect(state.requests[id]?.status).toBe('open')
    expect(state.requests[id]?.answer).toBeUndefined()
  })

  it('keeps closed requests closed on the same connection', () => {
    for (const status of [
      'answered',
      'resolved-elsewhere',
      'cancelled',
      'expired',
    ] as const) {
      const state = run([
        {
          type: 'request.opened',
          request: approval({ status: 'answering', answer: deny }),
        },
        { type: 'request.closed', requestId: id, status },
        { type: 'request.opened', request: approval() },
      ])
      expect(state.requests[id]?.status).toBe(status)
    }
  })

  it('reopens any closed request that a newer connection re-sends (Hermes re-sends only open ones)', () => {
    for (const status of [
      'answered',
      'resolved-elsewhere',
      'cancelled',
      'expired',
    ] as const) {
      const state = run([
        { type: 'request.opened', request: approval() },
        { type: 'request.closed', requestId: id, status },
        { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
      ])
      expect(state.requests[id]?.status).toBe('open')
    }
  })

  it('syncs one conversation at a time, closing what Hermes no longer holds as resolved elsewhere', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      {
        type: 'request.opened',
        request: approval({ requestId: other, conversationId: 'c2' }),
      },
      {
        type: 'request.opened',
        request: approval({
          requestId: 'srq-00000000000c',
          status: 'answering',
          answer: deny,
        }),
      },
      { type: 'requests.synced', conversationId: 'c1', openRequestIds: [] },
    ])
    expect(state.requests[id]?.status).toBe('resolved-elsewhere')
    // Hermes cannot say whose answer it used; the sent answer stays visible.
    expect(state.requests['srq-00000000000c']).toMatchObject({
      status: 'resolved-elsewhere',
      answer: deny,
    })
    // Another conversation's open request is untouched by c1's sync.
    expect(state.requests[other]?.status).toBe('open')
  })

  it('lets a re-send after reconnect reopen a request a sync closed', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'requests.synced', conversationId: 'c1', openRequestIds: [] },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
    ])
    expect(state.requests[id]?.status).toBe('open')
  })

  // Review d2ace34c probe: reorders around a reconnect in the middle of an answer.
  // Epochs only move forward, and an outcome belongs to the attempt it names.
  const once = { kind: 'approval' as const, choice: 'once' as const }

  it('ignores a stale frame from an older connection, so an acknowledged answer stays answered', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
      // A late frame from connection 1 must not pull the request back to epoch 1...
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      {
        type: 'request.closed',
        requestId: id,
        status: 'answered',
        answer: deny,
        connectionEpoch: 1,
      },
      // ...so a duplicate re-send on connection 2 cannot reopen it.
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
    ])
    expect(state.requests[id]).toMatchObject({
      status: 'answered',
      answer: deny,
      lastSeenEpoch: 2,
    })
  })

  it('records the answer Hermes acknowledged, not a later attempt', () => {
    const state = run([
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
      {
        type: 'request.opened',
        request: approval({ lastSeenEpoch: 2, status: 'answering', answer: once }),
      },
      {
        type: 'request.closed',
        requestId: id,
        status: 'answered',
        answer: deny,
        connectionEpoch: 1,
      },
      // The second attempt then finds the request already ended.
      {
        type: 'request.closed',
        requestId: id,
        status: 'resolved-elsewhere',
        connectionEpoch: 2,
      },
    ])
    expect(state.requests[id]).toMatchObject({ status: 'answered', answer: deny })
  })

  it('does not let an older attempt failing unlock a newer attempt in flight', () => {
    const state = run([
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
      {
        type: 'request.opened',
        request: approval({ lastSeenEpoch: 2, status: 'answering', answer: once }),
      },
      { type: 'request.answer-failed', requestId: id, connectionEpoch: 1 },
    ])
    expect(state.requests[id]).toMatchObject({ status: 'answering', answer: once })
    // The current attempt failing still makes it answerable again.
    const failed = reduce(state, {
      type: 'request.answer-failed',
      requestId: id,
      connectionEpoch: 2,
    })
    expect(failed.requests[id]?.status).toBe('open')
  })

  it("does not let an older attempt's outcome close a request Hermes re-sent", () => {
    const state = run([
      {
        type: 'request.opened',
        request: approval({ status: 'answering', answer: deny }),
      },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
      {
        type: 'request.closed',
        requestId: id,
        status: 'resolved-elsewhere',
        connectionEpoch: 1,
      },
    ])
    expect(state.requests[id]).toMatchObject({ status: 'open', lastSeenEpoch: 2 })
  })

  it('does not let a sync from an older connection close a request re-sent since', () => {
    const state = run([
      { type: 'request.opened', request: approval() },
      { type: 'request.opened', request: approval({ lastSeenEpoch: 2 }) },
      {
        type: 'requests.synced',
        conversationId: 'c1',
        openRequestIds: [],
        connectionEpoch: 1,
      },
    ])
    expect(state.requests[id]?.status).toBe('open')
    const current = reduce(state, {
      type: 'requests.synced',
      conversationId: 'c1',
      openRequestIds: [],
      connectionEpoch: 2,
    })
    expect(current.requests[id]?.status).toBe('resolved-elsewhere')
  })

  // Review 91f30e07 SF4: app-level prompts have no conversation, so without
  // their own sync scope (filled from Hermes's app-level list) they could never
  // close.
  /** An app-level sudo prompt (`display.install.sudo` has no session). */
  const appLevel = (overrides: Partial<ServerRequest> = {}): ServerRequest => {
    const { conversationId: _none, ...request } = approval({
      kind: 'unsupported',
      unsupportedKind: 'sudo',
      choices: [],
      ...overrides,
    })
    return request
  }

  it('syncs app-level prompts as their own scope', () => {
    const sudo = appLevel({ requestId: 'srq-0000000000a1' })
    const opened = run([
      { type: 'request.opened', request: sudo },
      { type: 'request.opened', request: approval() },
    ])
    // A conversation's sync leaves app-level prompts alone, and the reverse.
    const afterConversation = reduce(opened, {
      type: 'requests.synced',
      conversationId: 'c1',
      openRequestIds: [id],
      connectionEpoch: 2,
    })
    expect(afterConversation.requests['srq-0000000000a1']?.status).toBe('open')
    const afterAppLevel = reduce(opened, {
      type: 'requests.synced',
      openRequestIds: [],
      connectionEpoch: 2,
    })
    expect(afterAppLevel.requests['srq-0000000000a1']?.status).toBe('resolved-elsewhere')
    expect(afterAppLevel.requests[id]?.status).toBe('open')
  })

  it('does not let an app-level sync close a prompt seen on a newer connection', () => {
    const sudo = appLevel({ requestId: 'srq-0000000000a2', lastSeenEpoch: 3 })
    const state = run([
      { type: 'request.opened', request: sudo },
      { type: 'requests.synced', openRequestIds: [], connectionEpoch: 2 },
    ])
    expect(state.requests['srq-0000000000a2']?.status).toBe('open')
  })

  it('never shows a prompt Cindl does not answer as being answered', () => {
    const sudo = approval({ kind: 'unsupported', unsupportedKind: 'sudo', choices: [] })
    const state = run([
      { type: 'request.opened', request: sudo },
      { type: 'request.opened', request: { ...sudo, status: 'answering' } },
    ])
    expect(state.requests[id]?.status).toBe('open')
  })

  it('ignores ids it has never seen, including inherited object keys', () => {
    const state = run([
      { type: 'request.closed', requestId: 'toString', status: 'cancelled' },
    ])
    expect(Object.keys(state.requests)).toEqual([])
  })
})

describe('prompts', () => {
  it('removes a dismissed prompt record', () => {
    const prompt = {
      clientId: 'p1',
      conversationId: 'c1',
      text: 'hello',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'uncertain' as const,
    }
    const state = run([
      { type: 'prompt.updated', prompt },
      { type: 'prompt.removed', clientId: 'p1' },
    ])
    expect(Object.keys(state.prompts)).toEqual([])
  })
})

describe('message completion', () => {
  it('keeps text that streamed after a tool row below it when the final text extends it', () => {
    const tool = {
      id: 't2',
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
        text: 'Checking. ',
      },
      { type: 'tool.updated', activity: tool },
      {
        type: 'message.delta',
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'text',
        text: 'Done',
      },
      {
        type: 'message.completed',
        conversationId: 'c1',
        messageId: 'm1',
        status: 'complete',
        text: 'Checking. Done.',
      },
    ])
    expect(state.messages.c1?.[0]?.parts).toEqual([
      { type: 'text', text: 'Checking. ' },
      { type: 'tool', toolId: 't2' },
      { type: 'text', text: 'Done.' },
    ])
  })

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

describe('notices', () => {
  it('keep their code, and none when the event names none', () => {
    const store = createStore(link)
    store.dispatch({ type: 'notice', level: 'info', message: 'Plain (fixture).' })
    store.dispatch({
      type: 'notice',
      level: 'warning',
      message: 'Coded (fixture).',
      code: 'sign-out-unconfirmed',
    })
    const [plain, coded] = store.getState().notices
    expect(plain).toEqual({ id: 1, level: 'info', message: 'Plain (fixture).' })
    expect(coded).toEqual({
      id: 2,
      level: 'warning',
      message: 'Coded (fixture).',
      code: 'sign-out-unconfirmed',
    })
  })
})

describe('switching Hermes', () => {
  const at = (
    origin: string | undefined,
    phase: LinkState['phase'] = 'online',
  ): CindlEvent => ({
    type: 'link.changed',
    link: {
      phase,
      since: '2026-01-01T00:00:02.000Z',
      connectionEpoch: 2,
      ...(origin ? { server: { origin } } : {}),
    },
  })
  const conversation: CindlEvent = {
    type: 'conversation.upserted',
    conversation: {
      id: 'c1',
      session: { storedId: 'c1' },
      title: 'c1',
      kind: 'side',
      status: 'idle',
    },
  }
  const A = 'https://hermes-a.example.test'
  const B = 'https://hermes-b.example.test'

  // Desktop review: a switch left the previous origin's conversations,
  // requests and screen state in every store.
  it('forgets everything from the previous Hermes when a link names another, keeping notices', () => {
    const before = run([
      at(A),
      conversation,
      { type: 'request.opened', request: approval() },
      { type: 'notice', level: 'warning', message: 'Sign-in to B did not complete.' },
    ])
    expect(Object.keys(before.conversations)).toEqual(['c1'])
    const after = reduce(before, at(B))
    expect(after.link.server?.origin).toBe(B)
    expect(Object.keys(after.conversations)).toEqual([])
    expect(Object.keys(after.requests)).toEqual([])
    expect(after.display).toBeUndefined()
    expect(after.notices).toEqual(before.notices)
  })

  it('keeps everything through a reconnect to the same Hermes or a link that names none', () => {
    const before = run([
      at(A),
      conversation,
      { type: 'request.opened', request: approval() },
    ])
    const after = [at(undefined, 'reconnecting'), at(A, 'online')].reduce(reduce, before)
    expect(Object.keys(after.conversations)).toEqual(['c1'])
    expect(Object.keys(after.requests)).toEqual(['srq-00000000000a'])
  })
})
