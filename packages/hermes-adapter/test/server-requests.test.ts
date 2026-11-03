import {
  connectRawClient,
  NOT_SHOWN_MESSAGE,
  type FakeHermes,
} from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import {
  sendAnswer,
  unhandledRequestAction,
  unsupportedKind,
  windowOwnedRequests,
  type HermesConnection,
  type InboundServerRequest,
  type UnhandledServerRequest,
} from '../src/index.ts'
import { bearerRest, connection, fakeHermes, recorder, until } from './harness.ts'

/** Cindl online with one live session; optionally a second Hermes client attached to it. */
async function setup(options: { otherClient?: boolean } = {}) {
  const fake = await fakeHermes()
  const session = fake.signIn()
  const requests: InboundServerRequest[] = []
  const unhandled: UnhandledServerRequest[] = []
  const rec = recorder({
    onServerRequest: (request) => requests.push(request),
    onUnhandledServerRequest: (request) => unhandled.push(request),
  })
  const conn = connection(fake, bearerRest(fake, session), rec)
  conn.start()
  await rec.waitFor((s) => s.phase === 'online')
  const created = (await conn.request('session.create', {
    close_on_disconnect: false,
  })) as {
    session_id: string
    stored_session_id: string
  }
  const other = options.otherClient ? await connectRawClient(fake, session) : undefined
  if (other)
    await other.request('session.resume', { session_id: created.stored_session_id })
  return { fake, conn, sid: created.session_id, requests, unhandled, other }
}

describe('server requests Cindl does not answer (S7)', () => {
  it('declines window-owned bridges with 4404 so the window showing the session still answers', async () => {
    const { fake, sid, unhandled, other, conn } = await setup({ otherClient: true })
    if (!other) throw new Error('no second client')
    const pending = fake.gateway.serverRequest(sid, 'window.read', {})
    const asked = await other.nextServerRequest()
    await until(() => unhandled.length === 1)
    expect(unhandled[0]).toMatchObject({
      method: 'window.read',
      action: 'decline',
      unsupportedKind: 'other',
    })
    expect(fake.gateway.open.has(asked.id)).toBe(true)
    other.send({ id: asked.id, result: { value: 'synthetic window text (fixture)' } })
    await expect(pending).resolves.toEqual({ value: 'synthetic window text (fixture)' })
    expect(fake.gateway.settled.map((s) => [s.id, s.outcome, typeof s.by])).toEqual([
      [asked.id, 'answered', 'number'],
    ])
    conn.stop()
    other.close()
  })

  it('never declines an app-level window request, which no vote settles, and leaves it open', async () => {
    const { fake, unhandled, conn } = await setup()
    const [cindl] = [...fake.gateway.connections]
    void fake.gateway.appRequest('window.read', {}, cindl)
    await until(() => unhandled.length === 1)
    expect(unhandled[0]).toMatchObject({
      method: 'window.read',
      action: 'leave-open',
      sessionId: '',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const [open] = [...fake.gateway.open.values()]
    expect(open?.declined.size).toBe(0)
    expect(fake.gateway.settled).toEqual([])
    conn.stop()
  })

  it('sends nothing at all for credential prompts and unknown kinds, so they stay open', async () => {
    const { fake, sid, unhandled, other, conn } = await setup({ otherClient: true })
    if (!other) throw new Error('no second client')
    const kinds = {
      sudo: 'sudo',
      'display.install.sudo': 'sudo',
      secret: 'secret',
      'vault.unlock_prompt': 'vault',
      'vault.save_login': 'vault',
      'vault.code': 'vault',
      'theme.pick': 'other',
      setup_beat: 'other',
      'something.new': 'other',
    } as const
    const pending = []
    for (const method of Object.keys(kinds)) {
      pending.push(fake.gateway.serverRequest(sid, method, {}))
      await other.nextServerRequest()
    }
    await until(() => unhandled.length === Object.keys(kinds).length)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(unhandled.map((u) => [u.method, u.unsupportedKind, u.action])).toEqual(
      Object.entries(kinds).map(([method, kind]) => [method, kind, 'leave-open']),
    )
    // No decline, no error, no empty value: every request is still open for the
    // other client (the TUI, the desktop app) and nothing settled or was dropped.
    expect([...fake.gateway.open.values()].map((r) => r.method)).toEqual(
      Object.keys(kinds),
    )
    expect(fake.gateway.settled).toEqual([])
    expect(fake.gateway.droppedResponses).toEqual([])
    // Hermes's own deadline ends them; the agent gets no value.
    for (const id of [...fake.gateway.open.keys()]) fake.gateway.expireRequest(id)
    expect(await Promise.all(pending)).toEqual(pending.map(() => null))
    conn.stop()
    other.close()
  })

  it('surfaces them again after a reconnect without answering them', async () => {
    const { fake, sid, unhandled, conn } = await setup()
    void fake.gateway.serverRequest(sid, 'secret', {})
    await until(() => unhandled.length === 1)
    fake.gateway.dropConnections()
    await until(() => conn.channel === undefined || conn.channel.closed)
    await until(() => conn.channel?.closed === false)
    const since = (await conn.request('session.events.since', {
      session_id: sid,
      last_seen: 0,
    })) as { open_requests: Array<{ id: string; method: string; params: unknown }> }
    conn.channel?.deliverOpenRequests(since.open_requests)
    expect(unhandled.map((u) => [u.method, u.replayed, u.action])).toEqual([
      ['secret', false, 'leave-open'],
      ['secret', true, 'leave-open'],
    ])
    expect(fake.gateway.settled).toEqual([])
    conn.stop()
  })

  it('never closes an unhandled request when Cindl is alone; Hermes times it out itself', async () => {
    const { fake, sid, unhandled, conn } = await setup()
    const pending = fake.gateway.serverRequest(sid, 'sudo', {})
    await until(() => unhandled.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const [open] = [...fake.gateway.open.values()]
    expect(open?.method).toBe('sudo')
    fake.gateway.expireRequest(open?.id ?? '')
    await expect(pending).resolves.toBeNull()
    expect(fake.gateway.settled).toEqual([
      expect.objectContaining({ outcome: 'timeout' }),
    ])
    conn.stop()
  })

  it('settles a window bridge at once when every client declined', async () => {
    const { fake, sid, other, conn } = await setup({ otherClient: true })
    if (!other) throw new Error('no second client')
    const pending = fake.gateway.serverRequest(sid, 'terminal.read', {})
    const asked = await other.nextServerRequest()
    other.send({ id: asked.id, error: { code: 4404, message: 'not shown (fixture)' } })
    await expect(pending).resolves.toEqual({
      value: JSON.stringify({ success: false, error: NOT_SHOWN_MESSAGE }),
    })
    conn.stop()
    other.close()
  })

  it('never declines on a canonical connection, where any error reply settles the request', async () => {
    const fake = await fakeHermes({ sessionAuthority: true })
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec)
    conn.start()
    const online = await rec.waitFor((s) => s.phase === 'online')
    if (online.phase !== 'online') throw new Error('not online')
    // The socket reports declines_not_shown (sidecar handler via legacy fallback)...
    expect(online.handshake.declinesNotShown).toBe(true)
    // ...but the owner settles on any error (gateway/session_server_requests.py:74-93).
    expect(conn.channel?.declinesCounted).toBe(false)
    conn.stop()
  })
})

describe('answering through request.answer (S4)', () => {
  const approval = (fake: FakeHermes, sid: string) =>
    fake.gateway.serverRequest(sid, 'approval', {
      request_id: 'b'.repeat(32),
      command: 'ls /srv/hermes-fixture',
      choices: ['once', 'session', 'always', 'deny'],
    })
  const rpc =
    (conn: HermesConnection) => (method: string, params: Record<string, unknown>) =>
      conn.request(method, params)

  it('answers with an acknowledged call, never a bare response frame', async () => {
    const { fake, sid, requests, conn } = await setup()
    const pending = approval(fake, sid)
    await until(() => requests.length === 1)
    const request = requests[0] as InboundServerRequest
    expect(Object.keys(request).sort()).toEqual(['id', 'method', 'params', 'replayed'])
    await expect(sendAnswer(rpc(conn), request.id, { choice: 'once' })).resolves.toEqual({
      kind: 'answered',
    })
    await expect(pending).resolves.toEqual({ choice: 'once' })
    // Settled by request.answer (no transport), not by a response frame from a socket.
    expect(fake.gateway.settled).toEqual([
      {
        id: request.id,
        method: 'approval',
        outcome: 'answered',
        result: { choice: 'once' },
      },
    ])
    expect(fake.calls.filter((c) => c.name === 'request.answer')).toHaveLength(1)
    conn.stop()
  })

  it('reports an answer to a request that already ended as no longer pending', async () => {
    const { fake, sid, requests, conn } = await setup()
    void approval(fake, sid)
    await until(() => requests.length === 1)
    const request = requests[0] as InboundServerRequest
    fake.gateway.expireRequest(request.id)
    await expect(sendAnswer(rpc(conn), request.id, { choice: 'deny' })).resolves.toEqual({
      kind: 'no-longer-pending',
    })
    conn.stop()
  })

  it('reports a refused answer as failed and leaves the request open', async () => {
    const { fake, sid, requests, conn } = await setup()
    void approval(fake, sid)
    await until(() => requests.length === 1)
    const request = requests[0] as InboundServerRequest
    fake.gateway.failNext.set('request.answer', 'error-5000')
    const refused = await sendAnswer(rpc(conn), request.id, { choice: 'deny' })
    expect(refused).toMatchObject({ kind: 'failed', delivered: true })
    expect(fake.gateway.open.has(request.id)).toBe(true)
    conn.stop()
    const offline = await sendAnswer(rpc(conn), request.id, { choice: 'deny' })
    expect(offline).toMatchObject({
      kind: 'failed',
      delivered: false,
      error: { code: 'offline' },
    })
    expect(fake.gateway.open.has(request.id)).toBe(true)
  })

  it('makes a re-send safe after an answer whose acknowledgement was lost', async () => {
    const { fake, sid, requests, conn } = await setup()
    const pending = approval(fake, sid)
    await until(() => requests.length === 1)
    const request = requests[0] as InboundServerRequest
    // Hermes applies the answer, then the socket dies before the reply.
    fake.gateway.failNext.set('request.answer', 'drop-before-response')
    const lost = await sendAnswer(rpc(conn), request.id, { choice: 'deny' })
    expect(lost).toMatchObject({ kind: 'failed', delivered: true })
    await expect(pending).resolves.toEqual({ choice: 'deny' })
    await until(() => conn.channel?.closed === false)
    // The first answer won; the re-send is told the request already ended.
    await expect(sendAnswer(rpc(conn), request.id, { choice: 'once' })).resolves.toEqual({
      kind: 'no-longer-pending',
    })
    conn.stop()
  })

  it('treats an unreadable acknowledgement as a failure', async () => {
    const outcome = await sendAnswer(
      () => Promise.resolve({ status: 'maybe' }),
      'srq-0123456789ab',
      { choice: 'deny' },
    )
    expect(outcome).toMatchObject({
      kind: 'failed',
      delivered: true,
      error: { code: 'protocol' },
    })
  })
})

describe('unhandled request policy table', () => {
  it('declines only window-owned bridges and only when Hermes counts declines', () => {
    for (const method of windowOwnedRequests) {
      expect(unhandledRequestAction(method, true, 'sid-1')).toBe('decline')
      expect(unhandledRequestAction(method, false, 'sid-1')).toBe('leave-open')
      // App-level: no vote can settle it, so nothing is sent.
      expect(unhandledRequestAction(method, true, '')).toBe('leave-open')
    }
    for (const method of [
      'secret',
      'sudo',
      'vault.unlock_prompt',
      'vault.save_login',
      'vault.code',
      'display.install.sudo',
      'theme.pick',
      'setup_beat',
      'something.new',
    ])
      expect(unhandledRequestAction(method, true, 'sid-1')).toBe('leave-open')
  })

  it('names what a credential prompt asks for', () => {
    expect(
      [
        'sudo',
        'display.install.sudo',
        'secret',
        'vault.code',
        'vault.x',
        'tour',
        'other.kind',
      ].map(unsupportedKind),
    ).toEqual(['sudo', 'sudo', 'secret', 'vault', 'vault', 'other', 'other'])
  })
})
