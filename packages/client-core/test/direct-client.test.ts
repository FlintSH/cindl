import {
  CindlError,
  CindlEvent,
  type Conversation,
  type ServerRequest,
} from '@cindl/contracts'
import { connectRawClient } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { webCryptoProvider } from '@cindl/hermes-adapter'
import {
  createDirectClient,
  entry,
  selectOpenRequests,
  sha256Hex,
  systemClock,
  type KeyValueStore,
} from '../src/index.ts'
import {
  fakeHermes,
  harness,
  memoryKv,
  memorySecrets,
  type Harness,
} from './direct-harness.ts'

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof CindlError ? error.code : String(error)),
  )

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function conversation(h: Harness, title = 'Side (fixture)'): Promise<Conversation> {
  return h.client.call('conversations.create', { title })
}

function assistantText(h: Harness, conversationId: string): string {
  const messages = entry(h.store.getState().messages, conversationId) ?? []
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
}

const requestOf = (h: Harness, requestId: string): ServerRequest | undefined =>
  entry(h.store.getState().requests, requestId)

const online = (h: Harness, epoch?: number) =>
  h.waitFor(
    () =>
      h.store.getState().link.phase === 'online' &&
      (epoch === undefined || h.store.getState().link.connectionEpoch >= epoch),
  )

/** The next turn asks for approval; `outcome` records what Hermes received. */
function approvalScript(
  h: Harness,
  choices: Array<'once' | 'session' | 'always' | 'deny'> = [
    'once',
    'session',
    'always',
    'deny',
  ],
) {
  const outcome: { result?: unknown; done?: boolean } = {}
  h.fake.gateway.script = async (turn) => {
    outcome.result = await turn.approval({ choices: [...choices] })
    outcome.done = true
  }
  return outcome
}

/** Submit a prompt in `target` (or a new conversation) and wait for its request. */
async function openRequest(h: Harness, target?: Conversation) {
  const c = target ?? (await conversation(h))
  await h.client.call('prompt.submit', {
    conversationId: c.id,
    clientId: `p-${c.id}`,
    text: 'export it',
  })
  const request = await h.waitFor(() =>
    selectOpenRequests(h.store.getState()).find((r) => r.conversationId === c.id),
  )
  return { c, request }
}

const approve = (h: Harness, requestId: string, choice: 'once' | 'deny') =>
  h.client.call('request.answer', {
    requestId,
    answer: { kind: 'approval', choice },
  })

describe('direct client: start', () => {
  it('tells its subscriber the link and capabilities when no Hermes is configured', async () => {
    const unreachable = () => Promise.reject(new Error('not used (fixture)'))
    const client = createDirectClient({
      auth: 'native-pkce',
      fetch: unreachable,
      socketFactory: () => {
        throw new Error('not used (fixture)')
      },
      clock: systemClock,
      kv: memoryKv(),
      secrets: memorySecrets(),
      crypto: webCryptoProvider(),
      authorizer: { authorize: unreachable },
      random: () => 0.5,
    })
    const events: CindlEvent[] = []
    client.subscribe((event) => events.push(event))
    await client.start()
    // The link starts out unconfigured; a renderer still needs to hear it once.
    expect(events.map((e) => e.type)).toEqual(['link.changed', 'capabilities.changed'])
    expect(events[0]).toMatchObject({ link: { phase: 'unconfigured' } })
    for (const event of events) CindlEvent.parse(event)
    client.stop()
  })
})

describe('direct client: sign-in, capabilities and conversations', () => {
  it('signs in, goes online and negotiates honest capabilities', async () => {
    const h = await harness()
    const state = h.store.getState()
    expect(state.link).toMatchObject({
      phase: 'online',
      auth: 'native-pkce',
      connectionEpoch: 1,
      server: {
        origin: h.fake.origin,
        hermesVersion: '0.22.5',
        authority: 'legacy-sidecar-v8',
        sessionAuthority: false,
      },
    })
    const caps = state.capabilities
    expect(caps['chat.stream']?.state).toBe('available')
    expect(caps['sessions.replay']?.state).toBe('limited')
    // SOUL.md waits for display.status to name the profile Hermes serves.
    await h.waitFor(
      () => h.store.getState().capabilities['soul.write']?.state === 'limited',
    )
    // Memory entries need the learning routes, which the read-only probe found.
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    expect(caps['connections.accounts']?.state).toBe('unsupported')
    expect(caps['presence.unified']?.state).toBe('unavailable')
    await h.waitFor(
      () => h.store.getState().capabilities['computer.control']?.state === 'available',
    )
  })

  it('lists stored sessions as conversations', async () => {
    const fake = await fakeHermes()
    fake.store.seedSession(fake.now(), 'Inventory (fixture)', [
      { role: 'user', text: 'How many batches? (fixture)' },
      { role: 'assistant', text: '42 batches (fixture).' },
    ])
    const h = await harness({ fake })
    const list = await h.client.call('conversations.list', {})
    expect(list.map((c) => [c.title, c.kind, c.status])).toEqual([
      ['Inventory (fixture)', 'side', 'unknown'],
    ])
    expect(Object.keys(h.store.getState().conversations)).toEqual([list[0]?.id])
  })

  it('creates a conversation, streams a reply and keeps the transcript in sync', async () => {
    const h = await harness()
    const c = await conversation(h)
    expect(c).toMatchObject({ kind: 'side', status: 'idle', session: { storedId: c.id } })
    const prompt = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'Plan the week',
    })
    expect(prompt).toMatchObject({ state: 'accepted', disposition: 'streaming' })
    await h.waitFor(
      () => assistantText(h, c.id) === 'Synthetic reply (fixture) to: Plan the week',
    )
    const history = await h.client.call('conversations.history', { conversationId: c.id })
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(
      h.events.some(
        (e) =>
          e.type === 'history.loaded' &&
          e.conversationId === c.id &&
          e.messages.length === 2,
      ),
    ).toBe(true)
  })

  it('renames through the fenced REST write, or the live session before the first prompt', async () => {
    const h = await harness()
    const fresh = await conversation(h)
    await h.client.call('conversations.rename', {
      conversationId: fresh.id,
      title: 'Renamed early',
    })
    expect(h.rpcCalls('session.title')).toBe(1)
    await h.client.call('prompt.submit', {
      conversationId: fresh.id,
      clientId: 'p1',
      text: 'hello',
    })
    const stored = await h.waitFor(() => h.fake.store.sessions.get(fresh.id))
    const before = stored.revision
    const renamed = await h.client.call('conversations.rename', {
      conversationId: fresh.id,
      title: 'Weekly plan',
    })
    expect(renamed.title).toBe('Weekly plan')
    expect(stored.title).toBe('Weekly plan')
    expect(stored.revision).toBe(before + 1)
    expect(
      h.fake.calls.filter((c) => c.name === 'PATCH /api/sessions/' + fresh.id),
    ).toHaveLength(1)
  })

  it('pins the main conversation on this device only', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    const b = await conversation(h, 'B')
    await h.client.call('conversations.setMain', { conversationId: a.id })
    await h.client.call('conversations.setMain', { conversationId: b.id })
    const conversations = h.store.getState().conversations
    expect(entry(conversations, a.id)?.kind).toBe('side')
    expect(entry(conversations, b.id)?.kind).toBe('main')
    expect([...h.kv.map.values()]).toContain(JSON.stringify(b.id))
  })

  it('goes offline on stop() and reconnects on start() (review M5)', async () => {
    const h = await harness()
    h.client.stop()
    expect(h.store.getState().link.phase).toBe('offline')
    expect(h.store.getState().capabilities['chat.stream']?.state).toBe('unavailable')
    await h.client.start()
    await online(h, 2)
    expect(
      h.fake.calls.filter((call) => call.name === 'POST /api/auth/ws-ticket'),
    ).toHaveLength(2)
  })
})

describe('direct client: approvals and questions', () => {
  it('answers an approval once with an offered choice; answered means sent', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    expect(request).toMatchObject({
      kind: 'approval',
      conversationId: c.id,
      choices: ['once', 'deny'],
      withheldChoices: ['session', 'always'],
      status: 'open',
    })
    expect(request.requestId).toMatch(/^srq-[0-9a-f]{12}$/)
    expect(entry(h.store.getState().conversations, c.id)?.status).toBe('waiting-on-you')
    const answered = await approve(h, request.requestId, 'once')
    expect(answered.status).toBe('answered')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
    expect(await codeOf(approve(h, request.requestId, 'deny'))).toBe('not-found')
    expect(requestOf(h, request.requestId)?.status).toBe('answered')
    expect(h.fake.gateway.droppedResponses).toEqual([])
  })

  it('refuses a choice Hermes did not offer without sending anything', async () => {
    const h = await harness()
    approvalScript(h, ['deny'])
    const { request } = await openRequest(h)
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('invalid')
    expect(h.fake.gateway.open.has(request.requestId)).toBe(true)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
  })

  it('reports an answer it could not send and keeps the request answerable', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { request } = await openRequest(h)
    h.breakSends(true)
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('offline')
    expect(
      h.events.some(
        (e) => e.type === 'request.answer-failed' && e.requestId === request.requestId,
      ),
    ).toBe(true)
    expect(requestOf(h, request.requestId)).toMatchObject({ status: 'open' })
    expect(requestOf(h, request.requestId)?.answer).toBeUndefined()
    h.breakSends(false)
    await approve(h, request.requestId, 'once')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
  })

  it('closes a request Hermes withdrew and refuses to answer it afterwards', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    h.fake.gateway.expireRequest(request.requestId)
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'expired')
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('not-found')
  })

  it('shows an approval resolved from another surface as resolved elsewhere', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    h.fake.gateway.resolveElsewhere(request.requestId, 'deny')
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
  })

  it('notices, while the card is open, that another client answered it', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    const other = await connectRawClient(fake, fake.signIn())
    await other.request('session.resume', { session_id: c.id })
    other.send({ id: request.requestId, result: { choice: 'deny' } })
    await h.waitFor(() => outcome.done)
    // The sidecar tells this client nothing (server_requests.py:281-317); the
    // periodic check of open_requests closes the card.
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
    other.close()
  })

  it('keeps a request that is newer than the open-request list it is missing from', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    approvalScript(h)
    const { c, request } = await openRequest(h)
    let raised: Promise<unknown> | undefined
    // Hermes raises a request after building the list and before writing it.
    fake.gateway.afterHandle = (method) => {
      if (method !== 'session.events.since' || raised) return
      raised = fake.gateway.serverRequest(c.session.runtimeId ?? '', 'approval', {
        request_id: 'd'.repeat(32),
        command: 'ls (fixture)',
      })
    }
    const newer = await h.waitFor(() =>
      selectOpenRequests(h.store.getState()).find(
        (r) => r.requestId !== request.requestId,
      ),
    )
    await pause(150)
    expect(requestOf(h, newer.requestId)?.status).toBe('open')
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    await approve(h, newer.requestId, 'deny')
    await expect(raised).resolves.toEqual({ choice: 'deny' })
  })

  it('maps an interrupt to cancelled approvals', async () => {
    const h = await harness()
    approvalScript(h)
    const { c, request } = await openRequest(h)
    await h.client.call('conversation.interrupt', { conversationId: c.id })
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'cancelled')
  })

  it('answers the open questions of a clarify set and never overrides a lock', async () => {
    const h = await harness()
    const outcome: { result?: unknown } = {}
    h.fake.gateway.script = async (turn) => {
      outcome.result = await turn.clarify([
        {
          qid: 'q0',
          question: 'Venue? (fixture)',
          choices: ['North', 'South'],
          multi_select: false,
        },
        {
          qid: 'q1',
          question: 'Days? (fixture)',
          choices: ['Mon', 'Tue'],
          multi_select: true,
        },
      ])
    }
    const { request } = await openRequest(h)
    expect(request.questions?.map((q) => [q.qid, q.multiSelect])).toEqual([
      ['q0', false],
      ['q1', true],
    ])
    const clarify = (answers: Record<string, { choices: string[] }>) =>
      h.client.call('request.answer', {
        requestId: request.requestId,
        answer: { kind: 'clarify', answers },
      })
    // One reply settles the whole set, so it must cover every open question.
    expect(await codeOf(clarify({ q0: { choices: ['North'] } }))).toBe('invalid')
    // Another client locks q0; this client sees the lock after a reconnect.
    h.fake.gateway.lockClarify(request.requestId, 'q0', 'South')
    h.fake.gateway.dropConnections()
    await online(h, 2)
    const relisted = await h.waitFor(() => requestOf(h, request.requestId)?.lockedAnswers)
    expect(relisted).toEqual({ q0: { choices: ['South'] } })
    expect(
      await codeOf(clarify({ q0: { choices: ['North'] }, q1: { choices: ['Mon'] } })),
    ).toBe('invalid')
    await clarify({ q1: { choices: ['Mon', 'Tue'] } })
    await h.waitFor(() => outcome.result)
    expect(outcome.result).toEqual({
      answers: { q0: 'South', q1: '["Mon","Tue"]' },
      outcome: 'submitted',
    })
  })

  it('shows a credential prompt read-only, never answers it, and closes it with Hermes', async () => {
    const h = await harness()
    const c = await conversation(h)
    void h.fake.gateway.serverRequest(c.session.runtimeId ?? '', 'sudo', {
      command: 'apt list (fixture)',
    })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({
      kind: 'unsupported',
      unsupportedKind: 'sudo',
      conversationId: c.id,
      status: 'open',
      title: 'Hermes is asking for a sudo password',
      choices: [],
    })
    // Nothing from Hermes's params is shown, the command included.
    expect(request.command).toBeUndefined()
    expect(entry(h.store.getState().conversations, c.id)?.status).toBe('waiting-on-you')
    expect(await codeOf(approve(h, request.requestId, 'deny'))).toBe('unsupported')
    // Nothing was sent: it stays open for the terminal or the desktop app.
    expect(h.rpcCalls('request.answer')).toBe(0)
    expect([...h.fake.gateway.open.values()].map((r) => r.method)).toEqual(['sudo'])
    expect(h.fake.gateway.settled).toEqual([])
    expect(h.store.getState().notices).toEqual([])
    h.fake.gateway.expireRequest(request.requestId)
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'expired')
  })

  it('closes an unsupported request once another surface answered it', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    const c = await conversation(h)
    const pending = fake.gateway.serverRequest(
      c.session.runtimeId ?? '',
      'setup_beat',
      {},
    )
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'other' })
    const other = await connectRawClient(fake, fake.signIn())
    other.send({ id: request.requestId, result: { value: 'next (fixture)' } })
    await expect(pending).resolves.toEqual({ value: 'next (fixture)' })
    // The sidecar tells this client nothing; the open-requests check closes it.
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
    other.close()
  })

  it('reopens an unsupported request Hermes re-lists after a reconnect', async () => {
    const h = await harness()
    const c = await conversation(h)
    void h.fake.gateway.serverRequest(c.session.runtimeId ?? '', 'secret', {})
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ unsupportedKind: 'secret', lastSeenEpoch: 1 })
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() => requestOf(h, request.requestId)?.lastSeenEpoch === 2)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === c.id &&
          e.openRequestIds.includes(request.requestId),
      ),
    ).toBe(true)
    expect(h.fake.gateway.settled).toEqual([])
  })

  it('closes the requests of a session Hermes reclaimed', async () => {
    const h = await harness()
    approvalScript(h)
    const { c, request } = await openRequest(h)
    h.fake.gateway.broadcast('session.reclaimed', {
      session_id: c.session.runtimeId ?? '',
      stored_session_id: c.id,
      reason: 'idle_timeout',
    })
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'cancelled')
    expect(
      entry(h.store.getState().conversations, c.id)?.session.runtimeId,
    ).toBeUndefined()
  })

  it('keeps an app-level prompt open across a reconnect while Hermes still lists it', async () => {
    const h = await harness()
    // display.install.sudo goes to the client that clicked Install, with no session
    // (tui_gateway/methods_display.py:202-206); Hermes registers it for every list.
    const [mine] = [...h.fake.gateway.connections]
    void h.fake.gateway.appRequest(
      'display.install.sudo',
      { profile_key: 'default' },
      mine,
    )
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({
      kind: 'unsupported',
      unsupportedKind: 'sudo',
      status: 'open',
      lastSeenEpoch: 1,
    })
    expect(request.conversationId).toBeUndefined()
    expect(h.store.getState().notices).toEqual([])
    expect(await codeOf(approve(h, request.requestId, 'deny'))).toBe('unsupported')
    expect(h.rpcCalls('request.answer')).toBe(0)
    // A disconnect cancels nothing app-level: the new connection lists it again.
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() =>
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === undefined &&
          e.connectionEpoch === 2 &&
          e.openRequestIds.includes(request.requestId),
      ),
    )
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(h.fake.gateway.settled).toEqual([])
  })

  it('shows app-level prompts another surface started and closes the ones Hermes stops listing', async () => {
    const fake = await fakeHermes()
    // Started elsewhere: no connection here gets the frame, only the list has it.
    void fake.gateway.appRequest('display.install.sudo', { profile_key: 'default' })
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'sudo' })
    expect(request.conversationId).toBeUndefined()
    // Hermes's own deadline ends it; the periodic list no longer holds it.
    fake.gateway.expireRequest(request.requestId)
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
    // Nothing was ever sent for it.
    expect(h.rpcCalls('request.answer')).toBe(0)
  })

  it('shows an app-level prompt another surface starts while connected, without a reconnect', async () => {
    const h = await harness({ deps: { connection: { requestSyncMs: 40 } } })
    await h.waitFor(() =>
      h.events.some(
        (e) => e.type === 'requests.synced' && e.conversationId === undefined,
      ),
    )
    expect(selectOpenRequests(h.store.getState())).toEqual([])
    // Started elsewhere after this client connected: its frame goes only there.
    void h.fake.gateway.appRequest('display.install.sudo', { profile_key: 'default' })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'sudo' })
    expect(h.store.getState().link.connectionEpoch).toBe(1)
  })

  it('keeps an app-level prompt whose frame arrived after the list call was sent (N4)', async () => {
    const h = await harness()
    let raised = false
    // Hermes registers a new app-level prompt after building the list and before sending it.
    h.fake.gateway.afterHandle = (method, params) => {
      if (method !== 'session.events.since' || params.session_id !== '' || raised) return
      if (h.store.getState().link.connectionEpoch < 1) return
      raised = true
      const newest = [...h.fake.gateway.connections].at(-1)
      void h.fake.gateway.appRequest(
        'display.install.sudo',
        { profile_key: 'default' },
        newest,
      )
    }
    h.fake.gateway.dropConnections()
    await online(h, 2)
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    await h.waitFor(() =>
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === undefined &&
          e.connectionEpoch === 2 &&
          e.openRequestIds.includes(request.requestId),
      ),
    )
    expect(requestOf(h, request.requestId)?.status).toBe('open')
  })

  it('changes nothing app-level when the list cannot be read', async () => {
    const h = await harness()
    const [mine] = [...h.fake.gateway.connections]
    void h.fake.gateway.appRequest(
      'display.install.sudo',
      { profile_key: 'default' },
      mine,
    )
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    h.fake.gateway.respondError = (method, params) =>
      method === 'session.events.since' && params.session_id === ''
        ? { code: 5000, message: 'list failed (fixture)' }
        : undefined
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await pause(60)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === undefined &&
          e.connectionEpoch === 2,
      ),
    ).toBe(false)
  })

  it('skips a whole clarify set by skipping every open question', async () => {
    const h = await harness()
    const outcome: { result?: unknown } = {}
    h.fake.gateway.script = async (turn) => {
      outcome.result = await turn.clarify([
        { qid: 'q0', question: 'Venue? (fixture)', choices: ['North', 'South'] },
        { qid: 'q1', question: 'Anything else? (fixture)' },
      ])
    }
    const { request } = await openRequest(h)
    await h.client.call('request.answer', {
      requestId: request.requestId,
      answer: {
        kind: 'clarify',
        answers: { q0: { skipped: true }, q1: { skipped: true } },
      },
    })
    await h.waitFor(() => outcome.result)
    // Each question reaches the agent as skipped, with outcome submitted, never cancelled.
    expect(outcome.result).toEqual({
      answers: { q0: null, q1: null },
      outcome: 'submitted',
    })
  })

  it('answers through request.answer and stays answering until Hermes acknowledges', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { request } = await openRequest(h)
    let release: () => void = () => undefined
    h.fake.gateway.beforeHandle = (method) =>
      method === 'request.answer'
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : undefined
    const answered = approve(h, request.requestId, 'once')
    await h.waitFor(() => h.rpcCalls('request.answer') === 1)
    expect(requestOf(h, request.requestId)?.status).toBe('answering')
    expect(h.events.some((e) => e.type === 'request.closed')).toBe(false)
    release()
    await expect(answered).resolves.toMatchObject({ status: 'answered' })
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
    // Settled by the acknowledged call, never by a bare response frame.
    expect(h.fake.gateway.settled).toEqual([
      expect.objectContaining({ id: request.requestId, outcome: 'answered' }),
    ])
    expect(h.fake.gateway.settled[0]?.by).toBeUndefined()
  })

  it('reports a request Hermes no longer waited for as resolved elsewhere', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    // Another client answered it with a bare frame: the sidecar tells this client nothing.
    const open = h.fake.gateway.open.get(request.requestId)
    h.fake.gateway.open.delete(request.requestId)
    open?.settle({ choice: 'deny' })
    const result = await h.client.call('request.answer', {
      requestId: request.requestId,
      answer: { kind: 'approval', choice: 'once' },
    })
    expect(result.status).toBe('resolved-elsewhere')
    const closing = h.events.filter(
      (e) =>
        (e.type === 'request.closed' || e.type === 'request.answer-failed') &&
        e.requestId === request.requestId,
    )
    expect(closing).toEqual([
      {
        type: 'request.closed',
        requestId: request.requestId,
        status: 'resolved-elsewhere',
        connectionEpoch: 1,
      },
    ])
    // The answer this client sent is kept for display (contract v4).
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'resolved-elsewhere',
      answer: { kind: 'approval', choice: 'once' },
    })
  })

  it('shows a request that arrives before the reply binding its session', async () => {
    const fake = await fakeHermes()
    const other = await connectRawClient(fake, fake.signIn())
    const created = (await other.request('session.create', {})) as {
      result: { session_id: string; stored_session_id: string }
    }
    const { session_id: sid, stored_session_id: storedId } = created.result
    await other.request('prompt.submit', { session_id: sid, text: 'hello (fixture)' })
    const h = await harness({ fake })
    await h.waitFor(() => fake.store.sessions.get(storedId)?.rows.length === 2)
    await h.client.call('conversations.list', {})
    let raised: Promise<unknown> | undefined
    // Hermes attaches this socket, then asks before it writes the resume reply.
    fake.gateway.afterHandle = (method) => {
      if (method !== 'session.resume' || raised) return
      raised = fake.gateway.serverRequest(sid, 'approval', {
        request_id: 'e'.repeat(32),
        command: 'ls (fixture)',
      })
    }
    await h.client.call('conversations.history', { conversationId: storedId })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request.conversationId).toBe(storedId)
    await approve(h, request.requestId, 'deny')
    await expect(raised).resolves.toEqual({ choice: 'deny' })
    other.close()
  })
})

describe('direct client: reconnect and replay', () => {
  it('reconnects with a fresh ticket, re-attaches and replays what it missed', async () => {
    const h = await harness()
    const c = await conversation(h)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.fake.gateway.script = async (turn) => {
      turn.emit('message.start', {})
      turn.emit('message.delta', { text: 'before the drop, ' })
      await gate
      turn.emit('message.delta', { text: 'while away, ' })
      turn.emit('message.delta', { text: 'and after.' })
      turn.emit('message.complete', {
        text: 'before the drop, while away, and after.',
        status: 'complete',
      })
    }
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'go',
    })
    await h.waitFor(() => assistantText(h, c.id) === 'before the drop, ')
    h.fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    release()
    await online(h, 2)
    await h.waitFor(
      () => assistantText(h, c.id) === 'before the drop, while away, and after.',
    )
    const deltas = h.events
      .filter((e) => e.type === 'message.delta')
      .map((e) => (e.type === 'message.delta' ? e.text : ''))
    expect(deltas).toEqual(['before the drop, ', 'while away, ', 'and after.'])
    expect(
      h.fake.calls.filter((call) => call.name === 'POST /api/auth/ws-ticket'),
    ).toHaveLength(2)
    // The replay and the app-level list share session.events.since.
    expect(h.rpcCalls('session.events.since')).toBeGreaterThanOrEqual(2)
    expect(
      h.events.some((e) => e.type === 'requests.synced' && e.conversationId === c.id),
    ).toBe(true)
  })

  it('reloads history instead of trusting replay after a Hermes restart', async () => {
    const h = await harness()
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'hi',
    })
    await h.waitFor(() => assistantText(h, c.id).startsWith('Synthetic reply'))
    await h.client.call('conversations.history', { conversationId: c.id })
    h.fake.gateway.restart()
    await h.waitFor(() =>
      h.events.some(
        (e) =>
          e.type === 'history.reset' &&
          e.conversationId === c.id &&
          e.reason === 'epoch-changed',
      ),
    )
    expect(entry(h.store.getState().messages, c.id)).toBeUndefined()
    await online(h)
    const reloaded = await h.client.call('conversations.history', {
      conversationId: c.id,
    })
    expect(reloaded.messages).toHaveLength(2)
  })

  it('reloads history when the replay window was truncated', async () => {
    const h = await harness()
    h.fake.gateway.ringMax = 2
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'hi',
    })
    await h.waitFor(() => assistantText(h, c.id).startsWith('Synthetic reply'))
    await h.client.call('conversations.history', { conversationId: c.id })
    h.fake.gateway.frozen = true
    const sid = c.session.runtimeId ?? ''
    for (let i = 0; i < 5; i++)
      h.fake.gateway.emit(sid, 'status.update', { kind: 'status', text: `step ${i}` })
    h.fake.gateway.frozen = false
    h.fake.gateway.dropConnections()
    await h.waitFor(() =>
      h.events.some((e) => e.type === 'history.reset' && e.reason === 'truncated'),
    )
  })

  it('offers a request raised while it was disconnected once it is back', async () => {
    const h = await harness()
    const c = await conversation(h)
    h.fake.gateway.dropConnections()
    // No client attached: Hermes keeps it for the next one (session_transports.py:58-67).
    const pending = h.fake.gateway.serverRequest(c.session.runtimeId ?? '', 'approval', {
      request_id: 'a'.repeat(32),
      command: 'ls (fixture)',
    })
    await online(h, 2)
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    await approve(h, request.requestId, 'deny')
    await expect(pending).resolves.toEqual({ choice: 'deny' })
  })

  it('closes requests another client answered while it was away', async () => {
    const h = await harness()
    h.fake.gateway.script = async (turn) => {
      await turn.approval()
    }
    const { request } = await openRequest(h)
    const open = h.fake.gateway.open.get(request.requestId)
    // Another client's reply settles it while Cindl's socket is down.
    h.fake.gateway.dropConnections()
    h.fake.gateway.open.delete(request.requestId)
    open?.settle({ choice: 'deny' })
    await online(h, 2)
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
  })

  it('reopens a request whose answer never reached Hermes', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { request } = await openRequest(h)
    // A silently dead socket: the answer is written but Hermes never reads it.
    h.fake.gateway.frozen = true
    const lost = approve(h, request.requestId, 'deny')
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'answering')
    await pause(30)
    h.fake.gateway.frozen = false
    expect(h.fake.gateway.open.has(request.requestId)).toBe(true)
    h.fake.gateway.dropConnections()
    // No acknowledgement: the call fails and the request is answerable again.
    expect(await codeOf(lost)).toBe('offline')
    expect(
      h.events.filter(
        (e) => e.type === 'request.answer-failed' && e.requestId === request.requestId,
      ),
    ).toHaveLength(1)
    await online(h, 2)
    // Hermes still lists it after the reconnect, so that answer did not land.
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'open')
    expect(outcome.done).toBeUndefined()
    await approve(h, request.requestId, 'once')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
  })

  it('keeps a live request that arrives while another session re-attaches (review H1)', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    const b = await conversation(h, 'B')
    let resumes = 0
    let raised: Promise<unknown> | undefined
    h.fake.gateway.beforeHandle = async (method) => {
      if (method !== 'session.resume' || ++resumes !== 2) return
      // One session is already back on the new socket when it asks for approval.
      raised = h.fake.gateway.serverRequest(a.session.runtimeId ?? '', 'approval', {
        request_id: 'c'.repeat(32),
        command: 'ls (fixture)',
      })
      await pause(50)
    }
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() => resumes >= 2)
    const request = await h.waitFor(() =>
      selectOpenRequests(h.store.getState()).find((r) => r.conversationId === a.id),
    )
    await pause(60)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(h.fake.gateway.live.get(b.session.runtimeId ?? '')?.connections.size).toBe(1)
    await approve(h, request.requestId, 'deny')
    await expect(raised).resolves.toEqual({ choice: 'deny' })
  })

  it('keeps every session and its requests when the socket drops while re-attaching (review H2)', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    const outcome = approvalScript(h)
    const { c: b, request } = await openRequest(h, await conversation(h, 'B'))
    let dropped = false
    h.fake.gateway.beforeHandle = (method) => {
      if (method !== 'session.resume' || dropped) return
      dropped = true
      h.fake.gateway.dropConnections()
    }
    h.fake.gateway.dropConnections()
    await online(h, 3)
    await h.waitFor(
      () => h.fake.gateway.live.get(b.session.runtimeId ?? '')?.connections.size === 1,
    )
    expect(h.fake.gateway.live.get(a.session.runtimeId ?? '')?.connections.size).toBe(1)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    await approve(h, request.requestId, 'once')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
  })

  it('closes a request with the reason Hermes gave while it was re-attaching (review M2)', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    h.fake.gateway.beforeHandle = (method) => {
      if (method === 'session.events.since')
        h.fake.gateway.expireRequest(request.requestId)
    }
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'expired')
    await pause(30)
    expect(requestOf(h, request.requestId)?.status).toBe('expired')
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('not-found')
  })
})

type Row = Array<string | number | boolean | null>

/** One request's lifecycle as compact rows, plus its conversation's syncs, in order. */
function lifecycle(h: Harness, requestId: string, conversationId: string): Row[] {
  const choice = (answer: unknown) =>
    (answer as { choice?: string } | undefined)?.choice ?? null
  return h.events.flatMap((e: CindlEvent): Row[] => {
    if (e.type === 'request.opened' && e.request.requestId === requestId)
      return [
        ['opened', e.request.status, e.request.lastSeenEpoch, choice(e.request.answer)],
      ]
    if (e.type === 'request.closed' && e.requestId === requestId)
      return [['closed', e.status, e.connectionEpoch ?? null, choice(e.answer)]]
    if (e.type === 'request.answer-failed' && e.requestId === requestId)
      return [['failed', e.connectionEpoch ?? null]]
    if (e.type === 'requests.synced' && e.conversationId === conversationId)
      return [['synced', e.openRequestIds.includes(requestId)]]
    return []
  })
}

describe('direct client: answer identity across reconnects', () => {
  it('ties each answer outcome to the connection it was sent on (drop mid-answer, answer again)', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    // The first answer is written to a silently dead socket: Hermes never reads it.
    h.fake.gateway.frozen = true
    const first = approve(h, request.requestId, 'deny')
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'answering')
    h.fake.gateway.frozen = false
    h.fake.gateway.dropConnections()
    expect(await codeOf(first)).toBe('offline')
    // Reconnect: Hermes still holds the request and re-lists it on the new connection.
    await online(h, 2)
    await h.waitFor(() => requestOf(h, request.requestId)?.lastSeenEpoch === 2)
    const second = await approve(h, request.requestId, 'once')
    expect(second.status).toBe('answered')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
    expect(lifecycle(h, request.requestId, c.id)).toEqual([
      ['opened', 'open', 1, null],
      ['opened', 'answering', 1, 'deny'],
      ['failed', 1],
      ['opened', 'open', 2, null],
      ['synced', true],
      ['opened', 'answering', 2, 'once'],
      ['closed', 'answered', 2, 'once'],
    ])
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'answered',
      lastSeenEpoch: 2,
      answer: { kind: 'approval', choice: 'once' },
    })
    expect(h.fake.gateway.settled).toEqual([
      expect.objectContaining({
        id: request.requestId,
        outcome: 'answered',
        result: { choice: 'once' },
      }),
    ])
  })

  it('keeps one answer when a history load re-lists the request while the answer is in flight', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    // Upstream session.resume runs in the worker pool (tui_gateway/server.py:180-199), so
    // its open-request snapshot can be older than an answer Hermes handles meanwhile.
    let release: () => void = () => undefined
    h.fake.gateway.beforeHandle = (method) =>
      method === 'request.answer'
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : undefined
    const answered = approve(h, request.requestId, 'deny')
    await h.waitFor(() => h.rpcCalls('request.answer') === 1)
    await h.client.call('conversations.history', { conversationId: c.id })
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'answering',
      answer: { kind: 'approval', choice: 'deny' },
    })
    release()
    await expect(answered).resolves.toMatchObject({ status: 'answered' })
    await h.waitFor(() => outcome.done)
    expect(lifecycle(h, request.requestId, c.id)).toEqual([
      ['opened', 'open', 1, null],
      ['opened', 'answering', 1, 'deny'],
      ['opened', 'open', 1, null],
      ['synced', true],
      ['closed', 'answered', 1, 'deny'],
    ])
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'answered',
      answer: { kind: 'approval', choice: 'deny' },
    })
    // The re-listed copy is not answerable again: nothing more is sent.
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('not-found')
    expect(h.rpcCalls('request.answer')).toBe(1)
  })

  it('reconnects instead of going online when a re-attach stalls on a live socket', async () => {
    // A re-attach that times out on a socket that is still up used to end
    // reconciliation early and still go online, leaving later conversations
    // unattached (their requests kept an older epoch and their events went nowhere).
    const h = await harness({ deps: { connection: { requestTimeoutMs: 300 } } })
    const a = await conversation(h, 'A')
    approvalScript(h)
    const { c: b, request } = await openRequest(h, await conversation(h, 'B'))
    h.fake.gateway.failNext.set('session.resume', 'no-response')
    h.fake.gateway.dropConnections()
    await online(h, 3)
    expect(h.store.getState().link.connectionEpoch).toBe(3)
    // Every conversation is attached to the socket that went online.
    for (const c of [a, b])
      expect(h.fake.gateway.live.get(c.session.runtimeId ?? '')?.connections.size).toBe(1)
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'open',
      lastSeenEpoch: 3,
    })
    await approve(h, request.requestId, 'once')
    expect(lifecycle(h, request.requestId, b.id).slice(-2)).toEqual([
      ['opened', 'answering', 3, 'once'],
      ['closed', 'answered', 3, 'once'],
    ])
  })

  it('skips a session whose resume fails and re-attaches the others', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    approvalScript(h)
    const { c: b, request: bad } = await openRequest(h, await conversation(h, 'B'))
    const { c, request: good } = await openRequest(h, await conversation(h, 'C'))
    // Hermes answers B's resume with an error every time.
    h.fake.gateway.respondError = (method, params) =>
      method === 'session.resume' && params.session_id === b.id
        ? { code: 5000, message: 'resume failed (fixture)' }
        : undefined
    h.fake.gateway.dropConnections()
    await online(h, 2)
    expect(h.store.getState().link.connectionEpoch).toBe(2)
    // B counts as gone here: detached, its request closed on this client.
    expect(
      entry(h.store.getState().conversations, b.id)?.session.runtimeId,
    ).toBeUndefined()
    expect(requestOf(h, bad.requestId)?.status).toBe('resolved-elsewhere')
    // The loop went on: A and C are attached and C's request is re-listed.
    for (const conv of [a, c])
      expect(
        h.fake.gateway.live.get(conv.session.runtimeId ?? '')?.connections.size,
      ).toBe(1)
    expect(requestOf(h, good.requestId)).toMatchObject({
      status: 'open',
      lastSeenEpoch: 2,
    })
  })
})

describe('direct client: prompts', () => {
  it('marks a prompt uncertain when the reply is lost and never sends it again', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    fake.gateway.failNext.set('prompt.submit', 'drop-before-response')
    const prompt = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-lost',
      text: 'charge the card',
    })
    expect(prompt.state).toBe('uncertain')
    await online(h, 2)
    await pause(50)
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    // The same client id is never sent again, even if the UI retries.
    const retried = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-lost',
      text: 'charge the card',
    })
    expect(retried.state).toBe('uncertain')
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    // A restarted app recovers it as uncertain and still does not send it.
    h.client.stop()
    const again = await harness({ fake, kv: h.kv, secrets: h.secrets })
    expect(entry(again.store.getState().prompts, 'p-lost')?.state).toBe('uncertain')
    expect(again.rpcCalls('prompt.submit')).toBe(1)
    await expect(
      again.client.call('prompt.discard', { clientId: 'p-lost' }),
    ).resolves.toEqual({ discarded: true })
    expect(
      again.events.some((e) => e.type === 'prompt.removed' && e.clientId === 'p-lost'),
    ).toBe(true)
    expect(entry(again.store.getState().prompts, 'p-lost')).toBeUndefined()
  })

  it('never sends an accepted client id again, even after a restart (review L5)', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-once',
      text: 'hello',
    })
    h.client.stop()
    const again = await harness({ fake, kv: h.kv, secrets: h.secrets })
    const retried = await again.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-once',
      text: 'hello',
    })
    expect(retried.state).toBe('accepted')
    expect(again.rpcCalls('prompt.submit')).toBe(1)
  })

  it('sends offline prompts behind a running turn instead of redirecting it (review M4)', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    const gates: Array<() => void> = []
    fake.gateway.script = async (turn) => {
      turn.emit('message.start', {})
      await new Promise<void>((resolve) => gates.push(resolve))
    }
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-run',
      text: 'long task',
    })
    await h.waitFor(() => gates.length === 1)
    fake.gateway.frozen = true
    fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    const queued = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-later',
      text: 'and then this',
    })
    expect(queued.state).toBe('queued-offline')
    fake.gateway.frozen = false
    await h.waitFor(
      () => entry(h.store.getState().prompts, 'p-later')?.state === 'accepted',
    )
    expect(entry(h.store.getState().prompts, 'p-later')?.disposition).toBe('queued')
    // Typed while online, the same message redirects the turn (Hermes's default).
    const typed = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-now',
      text: 'stop and do this',
    })
    expect(typed.disposition).toBe('redirected')
    for (const release of gates.splice(0)) release()
  })

  it('does not send a queued prompt discarded during the flush (review H3)', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    fake.gateway.frozen = true
    fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'one',
    })
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p2',
      text: 'two',
    })
    let discarded: Promise<unknown> | undefined
    fake.gateway.beforeHandle = async (method) => {
      if (method !== 'prompt.submit' || discarded) return
      discarded = h.client.call('prompt.discard', { clientId: 'p2' })
      await discarded
    }
    fake.gateway.frozen = false
    await h.waitFor(() => entry(h.store.getState().prompts, 'p1')?.state === 'accepted')
    await expect(discarded).resolves.toEqual({ discarded: true })
    await pause(50)
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    expect(entry(h.store.getState().prompts, 'p2')).toBeUndefined()
  })

  it('does not send a prompt it could not record as sending (review M1)', async () => {
    const base = memoryKv()
    const kv: KeyValueStore & { map: Map<string, string> } = {
      ...base,
      set: (key, value) =>
        value.includes('"state":"sending"')
          ? Promise.reject(new Error('disk full (fixture)'))
          : base.set(key, value),
    }
    const h = await harness({ kv })
    const c = await conversation(h)
    const prompt = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'hello',
    })
    expect(prompt.state).toBe('queued-offline')
    expect(prompt.error).toMatch(/could not record/)
    expect(h.rpcCalls('prompt.submit')).toBe(0)
  })
})

describe('direct client: owner edits, routines, connections, screen', () => {
  it('writes SOUL.md only when the reviewed version still matches', async () => {
    const h = await harness()
    await h.waitFor(() => h.store.getState().capabilities['soul.read'] !== undefined)
    const read = await h.client.call('soul.read', {})
    expect(read.version).toBe(sha256Hex(read.content))
    h.fake.store.profile('default').soul = 'Changed on the host (fixture)\n'
    expect(
      await codeOf(
        h.client.call('soul.write', {
          content: 'mine',
          expectedVersion: read.version,
          confirm: true,
        }),
      ),
    ).toBe('conflict')
    expect(h.fake.store.profile('default').soul).toBe('Changed on the host (fixture)\n')
    const fresh = await h.client.call('soul.read', {})
    const written = await h.client.call('soul.write', {
      content: 'Mine (fixture)\n',
      expectedVersion: fresh.version,
      confirm: true,
    })
    expect(written).toMatchObject({
      content: 'Mine (fixture)\n',
      version: sha256Hex('Mine (fixture)\n'),
    })
  })

  it('writes a skill only when the reviewed version still matches', async () => {
    const h = await harness()
    const skill = await h.client.call('skills.read', { name: 'fixture-notes' })
    const written = await h.client.call('skills.write', {
      name: 'fixture-notes',
      content: 'Notes v2 (fixture)\n',
      expectedVersion: skill.version,
      confirm: true,
    })
    expect(written).toMatchObject({
      content: 'Notes v2 (fixture)\n',
      version: sha256Hex('Notes v2 (fixture)\n'),
    })
    const onHost = h.fake.store.profile('default').skills.get('fixture-notes')
    if (onHost) onHost.content += 'edited elsewhere (fixture)\n'
    expect(
      await codeOf(
        h.client.call('skills.write', {
          name: 'fixture-notes',
          content: 'x',
          expectedVersion: written.version,
          confirm: true,
        }),
      ),
    ).toBe('conflict')
    expect(onHost?.content).toBe('Notes v2 (fixture)\nedited elsewhere (fixture)\n')
    const list = await h.client.call('skills.list', {})
    expect(list.map((s) => [s.name, s.enabled])).toEqual([
      ['fixture-notes', true],
      ['fixture-report', false],
    ])
  })

  it('lists routines including paused ones and pauses or resumes them through cron.manage', async () => {
    const h = await harness()
    const routines = await h.client.call('routines.list', {})
    expect(routines.map((r) => [r.id, r.enabled])).toEqual([
      ['fixture-job-1', true],
      ['fixture-job-2', false],
    ])
    const resumed = await h.client.call('routines.setEnabled', {
      id: 'fixture-job-2',
      enabled: true,
      confirm: true,
    })
    expect(resumed.enabled).toBe(true)
    expect(
      await codeOf(
        h.client.call('routines.setEnabled', {
          id: 'missing-job',
          enabled: false,
          confirm: true,
        }),
      ),
    ).toBe('not-found')
  })

  it('maps MCP health without transport details and refuses account coverage', async () => {
    const h = await harness()
    const servers = await h.client.call('connections.mcp', {})
    expect(servers.map((s) => [s.name, s.state, s.toolCount])).toEqual([
      ['fixture-notes', 'connected', 3],
      ['fixture-calendar', 'error', 0],
    ])
    expect(await codeOf(h.client.call('connections.accounts', {}))).toBe('unsupported')
    const memory = await h.client.call('memory.overview', {})
    expect(memory.items.map((i) => i.key)).toContain('builtin:memory')
    expect(h.fake.calls.some((c) => /connectors|\/api\/fs/.test(c.name))).toBe(false)
    // The only learning call is the read-only probe that establishes memory.text.
    expect(
      h.fake.calls.filter(
        (c) => /learning/.test(c.name) && c.name !== 'GET /api/learning/graph',
      ),
    ).toEqual([])
  })

  it('reports the agent screen and takes and returns control with its own viewer id', async () => {
    const h = await harness()
    expect(await h.client.call('display.status', {})).toMatchObject({
      status: 'running',
      controller: 'agent',
      leaseHeldByThisDevice: false,
    })
    const held = await h.client.call('display.acquireControl', { confirm: true })
    expect(held).toMatchObject({ controller: 'you', leaseHeldByThisDevice: true })
    expect(h.fake.store.display.holder).toBe('human')
    const returned = await h.client.call('display.releaseControl', {})
    expect(returned).toMatchObject({ controller: 'agent', leaseHeldByThisDevice: false })
    expect(h.fake.calls.some((c) => /display\.(start|stop|install)/.test(c.name))).toBe(
      false,
    )
  })
})

describe('direct client: the profile Hermes serves', () => {
  const soulKnown = (h: Harness) =>
    h.waitFor(() => h.store.getState().capabilities['soul.read'] !== undefined)

  it('edits the served profile, never `default`, under hermes -p <name> serve', async () => {
    const fake = await fakeHermes()
    const studio = fake.store.serveAs('studio')
    studio.soul = '# SOUL (fixture)\n\nStudio voice (fixture).\n'
    studio.memory.memory = ['Studio-only note (fixture).']
    const fallback = fake.store.profile('default')
    const defaultSoul = fallback.soul
    const defaultMemory = [...fallback.memory.memory]
    const h = await harness({ fake })
    await soulKnown(h)
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )

    const soul = await h.client.call('soul.read', {})
    expect(soul.content).toContain('Studio voice')
    await h.client.call('soul.write', {
      content: 'Studio, edited (fixture)\n',
      expectedVersion: soul.version,
      confirm: true,
    })
    expect(studio.soul).toBe('Studio, edited (fixture)\n')

    const entries = await h.client.call('memory.entries', {})
    expect(entries.map((e) => e.preview)).toEqual([
      'Studio-only note (fixture).',
      ...studio.memory.profile,
    ])
    const [first] = entries
    await h.client.call('memory.delete', { id: first?.id ?? '', confirm: true })
    expect(studio.memory.memory).toEqual([])
    // The default profile was never read or touched, and no request named a
    // profile Hermes does not serve (that loads its secrets upstream).
    expect(fallback.soul).toBe(defaultSoul)
    expect(fallback.memory.memory).toEqual(defaultMemory)
    expect(fake.store.otherProfileScopes).toEqual([])
  })

  it('refuses SOUL.md when Hermes serves a home no profile name addresses', async () => {
    const fake = await fakeHermes()
    fake.store.serveAs('custom')
    const h = await harness({ fake })
    await soulKnown(h)
    const capability = h.store.getState().capabilities['soul.write']
    expect(capability?.state).toBe('unavailable')
    expect(capability?.reason).toMatch(/no profile name addresses/)
    expect(await codeOf(h.client.call('soul.read', {}))).toBe('unavailable')
    expect(h.fake.calls.some((c) => /\/soul$/.test(c.name))).toBe(false)
  })

  it('uses a profile the platform pinned for SOUL.md and memory entries', async () => {
    const fake = await fakeHermes()
    const studio = fake.store.profile('studio')
    studio.memory.memory = ['Pinned-profile note (fixture).']
    const h = await harness({ fake, deps: { profile: 'studio' } })
    await soulKnown(h)
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    expect((await h.client.call('memory.entries', {}))[0]?.preview).toBe(
      'Pinned-profile note (fixture).',
    )
    expect((await h.client.call('soul.read', {})).content).toContain(
      'studio fixture agent',
    )
  })
})

describe('direct client: screen control across reconnects', () => {
  it("hands control back with the earlier viewer id, and never another viewer's lease", async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['computer.control']?.state === 'available',
    )
    await h.client.call('display.acquireControl', { confirm: true })
    h.fake.gateway.dropConnections()
    await online(h, 2)
    expect(h.store.getState().display?.controller).toBe('you')
    expect(await h.client.call('display.releaseControl', {})).toMatchObject({
      controller: 'agent',
      leaseHeldByThisDevice: false,
    })
    expect(h.fake.store.display.holder).toBe('agent')

    const other = await connectRawClient(h.fake, h.fake.signIn())
    const observed = (await other.request('display.observe', {})) as {
      result: { viewer_id: string }
    }
    await other.request('display.lease.acquire', { viewer_id: observed.result.viewer_id })
    await h.waitFor(() => h.store.getState().display?.controller === 'another-viewer')
    expect(await h.client.call('display.releaseControl', {})).toMatchObject({
      controller: 'another-viewer',
    })
    expect(h.fake.store.display.holderViewerId).toBe(observed.result.viewer_id)
    other.close()
  })
})

describe('direct client: memory entries', () => {
  const memoryCalls = (h: Harness) =>
    h.fake.calls
      .filter((c) => /learning|memory|\/api\/fs|files/i.test(c.name))
      .map((c) => c.name)

  it('keeps memory entries unknown after a transient probe failure and probes again', async () => {
    const fake = await fakeHermes()
    fake.failNextRest('GET /api/learning/graph', 503)
    const h = await harness({ fake })
    await h.waitFor(() => h.fake.calls.some((c) => c.name === 'GET /api/learning/graph'))
    // A 503 does not prove the routes are missing: unknown, not unsupported.
    await h.client.call('routines.list', {})
    expect(h.store.getState().capabilities['memory.text']).toBeUndefined()
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
  })

  it('negotiates memory entries from the learning routes and never reads memory files', async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    expect(memoryCalls(h)).toEqual(['GET /api/learning/graph'])
    // A Hermes without the routes: unsupported, with no fallback of any kind.
    const bare = await harness({ fake: await fakeHermes({ learningRoutes: false }) })
    const missing = await bare.waitFor(
      () => bare.store.getState().capabilities['memory.text']?.state === 'unsupported',
    )
    expect(missing).toBe(true)
    expect(bare.store.getState().capabilities['memory.text']?.reason).toMatch(
      /does not expose single memory entries/,
    )
    expect(await codeOf(bare.client.call('memory.entries', {}))).toBe('unsupported')
    expect(memoryCalls(bare)).toEqual(['GET /api/learning/graph'])
  })

  it('lists, reads, edits and deletes entries by their fingerprinted ids', async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    const entries = await h.client.call('memory.entries', {})
    expect(entries.map((e) => e.store)).toEqual(['memory', 'memory', 'profile'])
    for (const e of entries)
      expect(e.id).toMatch(/^memory:(memory|profile):\d+:[a-f0-9]{12}$/)
    const [first] = entries
    if (!first) throw new Error('no entries')
    const read = await h.client.call('memory.read', { id: first.id })
    expect(read).toMatchObject({ id: first.id, store: 'memory', content: first.preview })
    // The id is the version: an edit returns the entry under its new id.
    const written = await h.client.call('memory.write', {
      id: first.id,
      content: 'Studio calendar moved to Thursdays (fixture).',
      confirm: true,
    })
    expect(written.id).not.toBe(first.id)
    expect(written).toMatchObject({
      store: 'memory',
      content: 'Studio calendar moved to Thursdays (fixture).',
    })
    expect(h.fake.store.profile('default').memory.memory[0]).toBe(
      'Studio calendar moved to Thursdays (fixture).',
    )
    await expect(
      h.client.call('memory.delete', { id: written.id, confirm: true }),
    ).resolves.toEqual({ deleted: true })
    const after = await h.client.call('memory.entries', {})
    expect(after.map((e) => e.id)).not.toContain(written.id)
    expect(after).toHaveLength(2)
  })

  it('refuses stale ids, text over the store limit, positional ids and unconfirmed changes', async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    const [entry] = await h.client.call('memory.entries', {})
    if (!entry) throw new Error('no entries')
    const writes = () =>
      h.fake.calls.filter((c) => c.name === 'PUT /api/learning/node').length
    // Changed on the host after it was listed: Hermes refuses the old id.
    h.fake.store.profile('default').memory.memory[0] = 'Changed by the agent (fixture).'
    expect(
      await codeOf(
        h.client.call('memory.write', {
          id: entry.id,
          content: 'Mine (fixture).',
          confirm: true,
        }),
      ),
    ).toBe('conflict')
    expect(h.fake.store.profile('default').memory.memory[0]).toBe(
      'Changed by the agent (fixture).',
    )
    const [fresh] = await h.client.call('memory.entries', {})
    if (!fresh) throw new Error('no entries')
    // Longer than the agent-notes limit (2,200 by default).
    expect(
      await codeOf(
        h.client.call('memory.write', {
          id: fresh.id,
          content: 'x'.repeat(2_300),
          confirm: true,
        }),
      ),
    ).toBe('invalid')
    const sent = writes()
    // Refused before anything is sent: a positional id and a missing confirmation.
    const positional = await h.client
      .call('memory.read', { id: 'memory:memory:0' })
      .catch((e: unknown) => e as CindlError)
    expect(positional).toMatchObject({ code: 'invalid' })
    expect((positional as CindlError).message).toMatch(/^Not sent:/)
    expect(
      await codeOf(
        h.client.call('memory.write', {
          id: fresh.id,
          content: 'Unconfirmed (fixture).',
        } as unknown as { id: string; content: string; confirm: true }),
      ),
    ).toBe('invalid')
    expect(writes()).toBe(sent)
  })
})

describe('direct client: refusals', () => {
  it('reports loopback-token Hermes as incompatible and never reads its token', async () => {
    const fake = await fakeHermes({ mode: 'loopback' })
    const h = await harness({ fake, signIn: false })
    expect(h.store.getState().link).toMatchObject({
      phase: 'incompatible',
      lastError: { code: 'unsupported' },
    })
    expect(await codeOf(h.client.call('auth.signIn', { origin: fake.origin }))).toBe(
      'unsupported',
    )
    expect(h.store.getState().capabilities['chat.stream']?.state).toBe('unavailable')
    expect(fake.calls.some((c) => c.name === 'GET /')).toBe(false)
  })

  it('refuses operations whose capability is not usable, with the reason', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, signIn: false })
    expect(h.store.getState().link.phase).toBe('signed-out')
    const error = await h.client
      .call('conversations.list', {})
      .catch((e: unknown) => e as CindlError)
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'Sign in to Hermes first.',
    })
  })

  it('signs out locally and forgets the tokens', async () => {
    const h = await harness()
    await expect(h.client.call('auth.signOut', {})).resolves.toEqual({ localOnly: true })
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(h.secrets.map.size).toBe(0)
  })
})
