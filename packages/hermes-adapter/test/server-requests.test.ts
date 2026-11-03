import { connectRawClient, NOT_SHOWN_MESSAGE } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import {
  unhandledRequestAction,
  windowOwnedRequests,
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

describe('server requests Cindl does not answer (R2)', () => {
  it('declines window-owned bridges with 4404 so the window showing the session still answers', async () => {
    const { fake, sid, unhandled, other, conn } = await setup({ otherClient: true })
    if (!other) throw new Error('no second client')
    const pending = fake.gateway.serverRequest(sid, 'window.read', {})
    const asked = await other.nextServerRequest()
    await until(() => unhandled.length === 1)
    expect(unhandled[0]).toMatchObject({ method: 'window.read', action: 'decline' })
    expect(fake.gateway.open.has(asked.id)).toBe(true)
    other.send({ id: asked.id, result: { value: 'synthetic window text (fixture)' } })
    await expect(pending).resolves.toEqual({ value: 'synthetic window text (fixture)' })
    expect(fake.gateway.settled.map((s) => [s.id, s.outcome, typeof s.by])).toEqual([
      [asked.id, 'answered', 'number'],
    ])
    conn.stop()
    other.close()
  })

  it('leaves credential prompts open for the client that can answer them', async () => {
    const { fake, sid, unhandled, other, conn } = await setup({ otherClient: true })
    if (!other) throw new Error('no second client')
    for (const method of ['sudo', 'secret', 'vault.unlock_prompt', 'vault.code']) {
      const pending = fake.gateway.serverRequest(sid, method, {})
      const asked = await other.nextServerRequest()
      await until(() => unhandled.some((u) => u.id === asked.id))
      // Cindl sent nothing: the request is still open for the other client.
      expect(fake.gateway.open.has(asked.id)).toBe(true)
      other.send({ id: asked.id, result: { value: 'synthetic-answer-not-a-secret' } })
      await expect(pending).resolves.toEqual({ value: 'synthetic-answer-not-a-secret' })
    }
    expect(unhandled.every((u) => u.action === 'leave-open')).toBe(true)
    expect(fake.gateway.settled.every((s) => s.outcome === 'answered')).toBe(true)
    conn.stop()
    other.close()
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

  it('answers an approval once even if the handler tries twice', async () => {
    const { fake, sid, requests, conn } = await setup()
    const pending = fake.gateway.serverRequest(sid, 'approval', {
      request_id: 'b'.repeat(32),
      command: 'ls /srv/hermes-fixture',
      choices: ['once', 'session', 'always', 'deny'],
    })
    await until(() => requests.length === 1)
    const request = requests[0] as InboundServerRequest
    expect(request.respond({ choice: 'once' })).toBe(true)
    expect(request.respond({ choice: 'deny' })).toBe(false)
    expect(conn.channel?.respondTo(request.id, { choice: 'deny' })).toBe('duplicate')
    await expect(pending).resolves.toEqual({ choice: 'once' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.gateway.droppedResponses).toEqual([])
    conn.stop()
  })
})

describe('unhandled request policy table', () => {
  it('declines only window-owned bridges and only when Hermes counts declines', () => {
    for (const method of windowOwnedRequests) {
      expect(unhandledRequestAction(method, true)).toBe('decline')
      expect(unhandledRequestAction(method, false)).toBe('leave-open')
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
      expect(unhandledRequestAction(method, true)).toBe('leave-open')
  })
})
