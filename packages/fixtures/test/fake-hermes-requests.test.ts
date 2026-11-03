import { afterEach, describe, expect, it } from 'vitest'
import {
  connectRawClient,
  startFakeHermes,
  type FakeHermes,
  type RawClient,
} from '../src/fake-hermes/index.ts'

type Json = Record<string, unknown>

const fakes: FakeHermes[] = []
afterEach(async () => {
  for (const fake of fakes.splice(0)) {
    expect(fake.violations).toEqual([])
    await fake.close()
  }
})

async function waitFor<T>(check: () => T | undefined | false, ms = 3_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = check()
    if (value !== undefined && value !== false) return value
    if (Date.now() - started > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function setup() {
  const fake = await startFakeHermes()
  fakes.push(fake)
  const client = await connectRawClient(fake, fake.signIn())
  const created = (await client.request('session.create', {})) as {
    result: { session_id: string; stored_session_id: string }
  }
  return {
    fake,
    client,
    sid: created.result.session_id,
    storedId: created.result.stored_session_id,
  }
}

async function openRequests(client: RawClient, sid: string) {
  const since = (await client.request('session.events.since', {
    session_id: sid,
    last_seen: 0,
  })) as {
    result: { open_requests: Array<{ id: string; method: string; params: Json }> }
  }
  return since.result.open_requests
}

const events = (client: RawClient, type: string) =>
  client.frames
    .filter((f) => f.method === 'event' && (f.params as Json).type === type)
    .map((f) => (f.params as Json).payload as Json)

const questions = [
  {
    qid: 'q0',
    question: 'Venue? (fixture)',
    choices: ['North', 'South'],
    multi_select: false,
  },
  { qid: 'q1', question: 'Days? (fixture)', choices: ['Mon', 'Tue'], multi_select: true },
]

describe('fake Hermes: server requests', () => {
  it('keeps a request raised while no client is attached for the next one (session_transports.py:58-67)', async () => {
    const { fake, client, sid, storedId } = await setup()
    let release: () => void = () => undefined
    const outcome: { result?: unknown } = {}
    fake.gateway.script = async (turn) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      outcome.result = await turn.approval()
    }
    await client.request('prompt.submit', { session_id: sid, text: 'go' })
    client.close()
    await waitFor(() => fake.gateway.live.get(sid)?.connections.size === 0)
    release()
    await waitFor(() => fake.gateway.open.size === 1)
    const other = await connectRawClient(fake, fake.signIn())
    const resumed = (await other.request('session.resume', { session_id: storedId })) as {
      result: { session_id: string }
    }
    expect(resumed.result.session_id).toBe(sid)
    const [listed] = await openRequests(other, sid)
    expect(listed?.method).toBe('approval')
    other.send({ id: listed?.id, result: { choice: 'once' } })
    await waitFor(() => outcome.result)
    expect(outcome.result).toEqual({ choice: 'once' })
    other.close()
  })

  it('fails the wait at once when the attached clients do not answer requests', async () => {
    const { fake, client, sid, storedId } = await setup()
    client.close()
    await waitFor(() => fake.gateway.live.get(sid)?.connections.size === 0)
    const watcher = await connectRawClient(fake, fake.signIn(), {
      answersRequests: false,
    })
    await watcher.request('session.resume', { session_id: storedId })
    await expect(
      fake.gateway.serverRequest(sid, 'sudo', { command: 'apt list (fixture)' }),
    ).resolves.toBeNull()
    expect(fake.gateway.open.size).toBe(0)
    watcher.close()
  })

  it('lists locked clarify answers and lays a reply over them (clarify_batch.py:27-31)', async () => {
    const { fake, client, sid } = await setup()
    const outcome: { result?: unknown } = {}
    fake.gateway.script = async (turn) => {
      outcome.result = await turn.clarify(questions)
    }
    const asked = client.nextServerRequest()
    await client.request('prompt.submit', { session_id: sid, text: 'book it' })
    const request = await asked
    fake.gateway.lockClarify(request.id, 'q0', 'South')
    const [listed] = await openRequests(client, sid)
    expect(listed?.params.answers).toEqual({ q0: 'South' })
    // The frame wins per question it carries; locks fill in the rest.
    client.send({ id: request.id, result: { answers: { q1: '["Mon"]' } } })
    await waitFor(() => outcome.result)
    expect(outcome.result).toEqual({
      answers: { q0: 'South', q1: '["Mon"]' },
      outcome: 'submitted',
    })
  })

  it('settles a clarify set on its last lock and treats an empty reply as cancel-all', async () => {
    const { fake, client, sid } = await setup()
    const outcomes: unknown[] = []
    fake.gateway.script = async (turn) => {
      outcomes.push(await turn.clarify(questions))
      outcomes.push(await turn.clarify(questions))
    }
    const first = client.nextServerRequest()
    await client.request('prompt.submit', { session_id: sid, text: 'book it' })
    const request = await first
    const second = client.nextServerRequest()
    fake.gateway.lockClarify(request.id, 'q0', 'North')
    fake.gateway.lockClarify(request.id, 'q1', null)
    await waitFor(() => outcomes.length === 1)
    expect(outcomes[0]).toEqual({
      answers: { q0: 'North', q1: null },
      outcome: 'submitted',
    })
    const next = await second
    fake.gateway.lockClarify(next.id, 'q0', 'South')
    client.send({ id: next.id, result: {} })
    await waitFor(() => outcomes.length === 2)
    expect(outcomes[1]).toEqual({ answers: { q0: 'South' }, outcome: 'cancelled' })
  })

  it('withdraws an approval resolved from another surface with reason resolved', async () => {
    const { fake, client, sid } = await setup()
    const outcome: { result?: unknown } = {}
    fake.gateway.script = async (turn) => {
      outcome.result = await turn.approval()
    }
    const asked = client.nextServerRequest()
    await client.request('prompt.submit', { session_id: sid, text: 'go' })
    const request = await asked
    const other = await connectRawClient(fake, fake.signIn())
    const resolved = (await other.request('approval.respond', {
      session_id: sid,
      choice: 'deny',
    })) as { result: Json }
    expect(resolved.result).toEqual({ resolved: 1 })
    await waitFor(() => events(client, 'request.cancel').length)
    expect(events(client, 'request.cancel')).toEqual([
      { id: request.id, method: 'approval', reason: 'resolved' },
    ])
    expect(outcome.result).toEqual({ choice: 'deny' })
    // A late frame for it is dropped, like server_requests.resolve_response.
    client.send({ id: request.id, result: { choice: 'once' } })
    await waitFor(() => fake.gateway.droppedResponses.includes(request.id))
    other.close()
  })

  it('queues a prompt sent with queued:true behind a running turn and redirects one without', async () => {
    const { fake, client, sid } = await setup()
    const texts: string[] = []
    const gates: Array<() => void> = []
    fake.gateway.script = async (turn) => {
      texts.push(turn.text)
      await new Promise<void>((resolve) => gates.push(resolve))
    }
    await client.request('prompt.submit', { session_id: sid, text: 'first' })
    await waitFor(() => texts.length === 1)
    const queued = (await client.request('prompt.submit', {
      session_id: sid,
      text: 'second',
      queued: true,
    })) as { result: Json }
    expect(queued.result).toEqual({ status: 'queued' })
    gates.shift()?.()
    await waitFor(() => texts.length === 2)
    const redirected = (await client.request('prompt.submit', {
      session_id: sid,
      text: 'instead',
    })) as { result: Json }
    expect(redirected.result).toEqual({ status: 'redirected' })
    expect(events(client, 'message.complete')).toContainEqual({
      text: '',
      status: 'interrupted',
    })
    gates.shift()?.()
    await waitFor(() => texts.length === 3)
    expect(texts).toEqual(['first', 'second', 'instead'])
    gates.shift()?.()
  })
})
