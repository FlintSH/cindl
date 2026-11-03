import { nodeSocketFactory } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { runProbe } from '../scripts/live-probe.ts'
import { fakeHermes, until } from './harness.ts'

const ALLOWED = [
  'GET /api/status',
  'GET /api/auth/me',
  'POST /api/auth/ws-ticket',
  '/api/ws',
  'client.capabilities',
  'gateway.capabilities',
  'session.list',
]

async function probe(options: Parameters<typeof fakeHermes>[0] = {}, token?: string) {
  const fake = await fakeHermes(options)
  const session = fake.signIn()
  fake.store.seedSession(fake.now(), 'Private title (fixture)', [
    { role: 'user', text: 'private words (fixture)' },
  ])
  const lines: string[] = []
  const tickets: string[] = []
  const socketFactory = nodeSocketFactory()
  const code = await runProbe(
    { origin: fake.origin, token: token ?? session.accessToken },
    {
      out: (line) => lines.push(line),
      socketFactory: (url, protocols) => {
        tickets.push(...protocols)
        return socketFactory(url, protocols)
      },
    },
  )
  return { fake, session, code, output: lines.join('\n'), tickets }
}

describe('live probe', () => {
  it('reports compatibility using only read-only calls and prints no secret or content', async () => {
    const { fake, session, code, output, tickets } = await probe()
    expect(code).toBe(0)
    expect(output).toMatch(/authority: legacy-sidecar-v8/)
    expect(output).toMatch(/sessions: 1 stored/)
    expect(output).toMatch(/result: compatible/)
    expect(output).not.toContain(session.accessToken)
    const ticketValues = tickets
      .filter((p) => p.startsWith('hermes-gateway-ticket.'))
      .map((p) => p.slice('hermes-gateway-ticket.'.length))
    expect(ticketValues).toHaveLength(1)
    for (const ticket of ticketValues) expect(output).not.toContain(ticket)
    expect(output).not.toMatch(/Private title|private words|20\d{6}_\d{6}_/)
    const relevant = fake.calls
      .map((c) => c.name)
      .filter(
        (name) =>
          /^(GET |POST |PUT |PATCH |DELETE )?\/(api|auth)\//.test(name) ||
          !name.includes('/'),
      )
    for (const name of relevant) expect(ALLOWED).toContain(name)
    expect(relevant).not.toContain('prompt.submit')
    // The probe closes its socket when done.
    await until(() => fake.gateway.connections.size === 0)
  })

  it('advertises no server requests and attaches to no session', async () => {
    const { fake } = await probe()
    const capabilities = fake.calls.filter((c) => c.name === 'client.capabilities')
    expect(capabilities).toHaveLength(1)
    expect(fake.gateway.advertisements).toEqual([{}])
    expect(
      fake.calls.some((c) => /^session\.(create|resume|activate)$/.test(c.name)),
    ).toBe(false)
  })

  it('refuses an origin sign-in would refuse before sending anything', async () => {
    for (const origin of [
      'http://hermes.example.test',
      'ws://hermes.example.test',
      'https://owner:fixture-password@hermes.example.test',
      'https://hermes.example.test/api',
      'not a url',
    ]) {
      const requests: string[] = []
      const lines: string[] = []
      const code = await runProbe(
        { origin, token: 'fixture-access-token', cookieHeader: 'session=fixture-cookie' },
        {
          out: (line) => lines.push(line),
          fetch: (url) => {
            requests.push(url)
            return Promise.reject(new Error('the probe must not send anything'))
          },
          socketFactory: () => {
            throw new Error('the probe must not open a socket')
          },
        },
      )
      expect(code, origin).toBe(2)
      expect(requests, origin).toEqual([])
      expect(lines.join('\n'), origin).toMatch(/^error: --origin /)
      expect(lines.join('\n'), origin).not.toMatch(
        /fixture-password|fixture-access-token/,
      )
    }
  })

  it('stops at an unauthenticated token without retrying', async () => {
    const { code, output, fake } = await probe({}, 'not-a-valid-token')
    expect(code).toBe(3)
    expect(output).toMatch(/GET \/api\/auth\/me failed: unauthenticated/)
    expect(fake.calls.some((c) => c.name === 'POST /api/auth/ws-ticket')).toBe(false)
  })

  it('calls loopback-token mode incompatible and never reads the token', async () => {
    const { code, output } = await probe({ mode: 'loopback' })
    expect(code).toBe(5)
    expect(output).toMatch(/loopback-token mode/)
  })
})
