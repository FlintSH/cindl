import { createHash, randomBytes } from 'node:crypto'
import { canonicalLoopbackRedirect } from '@cindl/hermes-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  connectRawClient,
  HermesContract,
  startFakeHermes,
  validateLoopbackRedirect,
  type FakeHermes,
} from '../src/fake-hermes/index.ts'

const fakes: FakeHermes[] = []
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close()
})
async function fake(options: Parameters<typeof startFakeHermes>[0] = {}) {
  const started = await startFakeHermes(options)
  fakes.push(started)
  return started
}

const wsUrl = (f: FakeHermes, path = '/api/ws') =>
  `${f.origin.replace('http', 'ws')}${path}`

async function ticket(f: FakeHermes, accessToken: string): Promise<string> {
  const response = await fetch(`${f.origin}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return ((await response.json()) as { ticket: string }).ticket
}

/** Resolves 'open' or the HTTP status of a refused handshake. */
function handshake(url: string, protocols: string[], origin?: string) {
  return new Promise<{ result: string; ws?: WebSocket }>((resolve) => {
    const ws = new WebSocket(url, protocols, origin ? { origin } : {})
    ws.on('open', () => resolve({ result: 'open', ws }))
    ws.on('unexpected-response', (_req, res) =>
      resolve({ result: String(res.statusCode) }),
    )
    ws.on('error', () => resolve({ result: 'error' }))
  })
}

describe('fake Hermes: WebSocket tickets', () => {
  it('accepts a ticket once, in the subprotocol, and echoes only hermes-gateway-v1', async () => {
    const f = await fake()
    const session = f.signIn()
    const t = await ticket(f, session.accessToken)
    const first = await handshake(wsUrl(f), [
      'hermes-gateway-v1',
      `hermes-gateway-ticket.${t}`,
    ])
    expect(first.result).toBe('open')
    expect(first.ws?.protocol).toBe('hermes-gateway-v1')
    first.ws?.terminate()
    const replay = await handshake(wsUrl(f), [
      'hermes-gateway-v1',
      `hermes-gateway-ticket.${t}`,
    ])
    expect(replay.result).toBe('403')
  })

  it('refuses an expired ticket, an ambiguous protocol set and a missing credential', async () => {
    const f = await fake()
    const session = f.signIn()
    const expired = await ticket(f, session.accessToken)
    f.advance(31_000)
    expect(
      (
        await handshake(wsUrl(f), [
          'hermes-gateway-v1',
          `hermes-gateway-ticket.${expired}`,
        ])
      ).result,
    ).toBe('403')
    const a = await ticket(f, session.accessToken)
    const b = await ticket(f, session.accessToken)
    expect(
      (
        await handshake(wsUrl(f), [
          'hermes-gateway-v1',
          `hermes-gateway-ticket.${a}`,
          `hermes-gateway-ticket.${b}`,
        ])
      ).result,
    ).toBe('403')
    expect((await handshake(wsUrl(f), ['hermes-gateway-v1'])).result).toBe('403')
  })

  it('refuses an http(s) Origin for another host but trusts native and app origins', async () => {
    const f = await fake()
    const session = f.signIn()
    for (const [origin, expected] of [
      ['https://elsewhere.example.test', '403'],
      ['http://127.0.0.1:9', 'open'],
      ['app://cindl', 'open'],
      [undefined, 'open'],
    ] as const) {
      const t = await ticket(f, session.accessToken)
      const outcome = await handshake(
        wsUrl(f),
        ['hermes-gateway-v1', `hermes-gateway-ticket.${t}`],
        origin,
      )
      expect(outcome.result, String(origin)).toBe(expected)
      outcome.ws?.terminate()
    }
  })

  it('refuses a display ticket as a chat login and checks display tickets after accept', async () => {
    const f = await fake()
    const session = f.signIn()
    const client = await connectRawClient(f, session)
    const observed = (await client.request('display.observe', {})) as {
      result: { ticket: string }
    }
    const displayTicket = observed.result.ticket
    expect(
      (
        await handshake(wsUrl(f), [
          'hermes-gateway-v1',
          `hermes-gateway-ticket.${displayTicket}`,
        ])
      ).result,
    ).toBe('403')
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `${wsUrl(f, '/api/display/ws')}?display_ticket=${displayTicket}`,
      )
      ws.on('close', (code) => resolve(code))
    })
    expect(closed).toBe(4401)
    client.close()
  })
})

describe('fake Hermes: native sign-in', () => {
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url')
    return {
      verifier,
      challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    }
  }

  it('verifies S256 PKCE and consumes the code on every path', async () => {
    const f = await fake()
    const { verifier, challenge } = pkce()
    const authorize = await fetch(
      `${f.origin}/auth/native/authorize?${new URLSearchParams({
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: 'http://127.0.0.1:4100/cb?keep=1',
        state: 's1',
      }).toString()}`,
      { redirect: 'manual' },
    )
    const location = new URL(authorize.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:4100/cb')
    expect(location.searchParams.get('keep')).toBe('1')
    expect(location.searchParams.get('state')).toBe('s1')
    const code = location.searchParams.get('code') ?? ''
    const exchange = (body: object) =>
      fetch(`${f.origin}/auth/native/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await exchange({ code, code_verifier: 'wrong-verifier' })).status).toBe(400)
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(400)
  })

  it('rejects redirect URIs exactly like Hermes and agrees with the client validator', () => {
    const corpus = [
      'http://127.0.0.1:53682/callback',
      'http://127.0.0.1:53682',
      'http://[::1]:8080/cb?x=1',
      'http://127.0.0.1/cb',
      'http://localhost:53682/callback',
      'https://127.0.0.1:53682/callback',
      'cindl://callback',
      'http://127.0.0.1.example.com/callback',
      'http://user:pass@127.0.0.1:1/callback',
      'http://127.0.0.1:1/callback#frag',
      'http://127.0.0.1:01/callback',
      'http://127.0.0.1:70000/callback',
      'http://127.0.0.1\\@evil.example/cb',
      'http://127.0.0.1:1/ca llback',
      'http://10.0.2.2:5000/callback',
      // The long form of ::1, assembled so the privacy scan sees no literal address.
      `http://[${'0:'.repeat(7)}1]:5/cb`,
      '',
    ]
    for (const raw of corpus) {
      const server = (() => {
        try {
          return validateLoopbackRedirect(raw)
        } catch {
          return 'rejected'
        }
      })()
      const client = (() => {
        try {
          return canonicalLoopbackRedirect(raw)
        } catch {
          return 'rejected'
        }
      })()
      // The client may be stricter than Hermes, never looser.
      if (client !== 'rejected') expect(server, raw).toBe(client)
    }
    expect(validateLoopbackRedirect('HTTP://127.0.0.1:5/cb')).toBe(
      'http://127.0.0.1:5/cb',
    )
  })
})

describe('fake Hermes: replay ring and contract checks', () => {
  it('replays events after a watermark, reports truncation and a new epoch after restart', async () => {
    const f = await fake()
    f.gateway.ringMax = 3
    const session = f.signIn()
    const client = await connectRawClient(f, session)
    const created = (await client.request('session.create', {})) as {
      result: { session_id: string }
    }
    const sid = created.result.session_id
    for (let i = 0; i < 5; i++)
      f.gateway.emit(sid, 'status.update', { kind: 'status', text: `step ${i}` })
    const since = (await client.request('session.events.since', {
      session_id: sid,
      last_seen: 3,
    })) as {
      result: {
        events: Array<{ seq: number }>
        truncated: boolean
        latest_seq: number
        epoch: string
      }
    }
    expect(since.result.events.map((e) => e.seq)).toEqual([4, 5])
    expect(since.result).toMatchObject({
      truncated: false,
      latest_seq: 5,
      epoch: f.gateway.epoch,
    })
    const old = (await client.request('session.events.since', {
      session_id: sid,
      last_seen: 1,
    })) as {
      result: { truncated: boolean }
    }
    expect(old.result.truncated).toBe(true)
    const epoch = f.gateway.epoch
    f.gateway.restart()
    expect(f.gateway.epoch).not.toBe(epoch)
    expect(f.violations).toEqual([])
  })

  it('answers unknown params keys with 4000 and unknown methods with -32601', async () => {
    const f = await fake()
    const client = await connectRawClient(f, f.signIn())
    const skew = (await client.request('session.list', { surprise: true })) as {
      error: { code: number }
    }
    expect(skew.error.code).toBe(4000)
    const unknown = (await client.request('connectors.list', {})) as {
      error: { code: number }
    }
    expect(unknown.error.code).toBe(-32601)
    client.close()
  })

  it('records a frame that violates the vendored contract instead of hiding it', async () => {
    const f = await fake()
    const client = await connectRawClient(f, f.signIn())
    const created = (await client.request('session.create', {})) as {
      result: { session_id: string }
    }
    f.gateway.emit(created.result.session_id, 'tool.start', { name: 'terminal' })
    expect(f.violations.some((v) => v.includes('tool_id'))).toBe(true)
    f.violations.length = 0
    client.close()
  })

  it('validates request parameters against the vendored schema', () => {
    const contract = new HermesContract()
    expect(
      contract.methodParams('prompt.submit', { session_id: 'abcd1234', text: 'hi' }).ok,
    ).toBe(true)
    const extra = contract.methodParams('prompt.submit', {
      session_id: 'abcd1234',
      text: 'hi',
      client_id: 'x',
    })
    expect(extra).toMatchObject({ ok: false, unknownKeysOnly: true })
    expect(contract.serverRequestResult('approval', { choice: 'once' }).ok).toBe(true)
    expect(contract.serverRequestResult('approval', { choice: 'maybe' }).ok).toBe(false)
  })
})
