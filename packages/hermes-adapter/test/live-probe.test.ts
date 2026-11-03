import { FIXTURE_HOME, nodeSocketFactory } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { main, runDiscovery, runProbe } from '../scripts/live-probe.ts'
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

describe('live probe --discover: the first live check, with no credentials', () => {
  const PUBLIC_READS = ['GET /api/status', 'GET /api/auth/providers']

  /** Every request the discovery sends, with the headers that could carry a credential. */
  async function discover(origin: string) {
    const lines: string[] = []
    const sent: Array<{
      url: string
      authorization?: string
      cookie?: string
      credentials?: string
    }> = []
    const code = await runDiscovery(
      { origin },
      {
        out: (line) => lines.push(line),
        fetch: (url, init) => {
          const headers = new Headers(init.headers)
          sent.push({
            url,
            ...(headers.get('authorization') ? { authorization: 'present' } : {}),
            ...(headers.get('cookie') ? { cookie: 'present' } : {}),
            ...(init.credentials ? { credentials: init.credentials } : {}),
          })
          return fetch(url, init)
        },
      },
    )
    return { code, output: lines.join('\n'), sent }
  }

  /** What the fake saw, beyond its own bookkeeping. */
  const requests = (fake: { calls: Array<{ name: string }> }) =>
    fake.calls.map((c) => c.name)

  it('answers 0 when a provider supports native PKCE, reading only the public routes', async () => {
    const fake = await fakeHermes()
    const { code, output, sent } = await discover(fake.origin)
    expect(code).toBe(0)
    expect(output).toMatch(/version: 0\.22\.5 \(verified baseline v0\.22\.5: yes\)/)
    expect(output).toMatch(/auth: required=true flows=cookie,native_pkce/)
    expect(output).toMatch(/providers: 1 registered, 1 can sign in with native PKCE/)
    expect(output).toMatch(/result: compatible/)
    expect(requests(fake)).toEqual(PUBLIC_READS)
    // No credential of any kind, even an ambient cookie.
    expect(
      sent.every((r) => !r.authorization && !r.cookie && r.credentials === 'omit'),
    ).toBe(true)
  })

  it('answers 5 for loopback-token mode, after one public read', async () => {
    const fake = await fakeHermes({ mode: 'loopback' })
    const { code, output } = await discover(fake.origin)
    expect(code).toBe(5)
    expect(output).toMatch(/auth: required=false/)
    expect(output).toMatch(/loopback-token mode/)
    expect(requests(fake)).toEqual(['GET /api/status'])
    // Loopback mode's recon fields (home path, config path, pid) never reach the output.
    expect(output).not.toContain(FIXTURE_HOME)
    expect(output).not.toMatch(/hermes-fixture|config\.yaml|4242/)
  })

  it('answers 5 when no provider can sign in with native PKCE', async () => {
    // A token-only credential (drain) registers a provider but no sign-in option.
    const fake = await fakeHermes({
      providers: [{ name: 'fixture-drain', session: false }],
    })
    const { code, output } = await discover(fake.origin)
    expect(code).toBe(5)
    expect(output).toMatch(/flows=cookie(?!,native_pkce)/)
    expect(output).toMatch(/providers: 1 registered, 0 can sign in with native PKCE/)
    expect(output).toMatch(
      /result: incompatible\. No sign-in provider supports native PKCE/,
    )
    expect(requests(fake)).toEqual(PUBLIC_READS)
  })

  it('answers 4, not 5, when a 503 on the providers read is not Hermes saying none', async () => {
    // A proxy in front of Hermes can answer 503 too; only Hermes's own
    // "no auth providers registered" means there are none.
    const fake = await fakeHermes()
    fake.failNextRest('GET /api/auth/providers', 503)
    const { code, output } = await discover(fake.origin)
    expect(code).toBe(4)
    expect(output).toMatch(/GET \/api\/auth\/providers failed/)
  })

  it('answers 4 when Hermes cannot be reached', async () => {
    // Nothing listens on 127.0.0.1:1.
    const { code, output, sent } = await discover('http://127.0.0.1:1')
    expect(code).toBe(4)
    expect(output).toMatch(/GET \/api\/status failed: offline/)
    expect(sent).toHaveLength(1)
  })

  it('answers 2 for an origin sign-in would refuse, sending nothing', async () => {
    // Plain http off 127.0.0.1 and [::1] is refused; a loopback-range address
    // keeps even a broken check from sending anything off this machine.
    const { code, sent } = await discover('http://127.0.0.2:1')
    expect(code).toBe(2)
    expect(sent).toEqual([])
  })

  it('prints no provider name, host or token-like string', async () => {
    const fake = await fakeHermes({
      providers: [
        { name: 'acme-sso-fixture', displayName: 'Acme Single Sign-On (fixture)' },
        { name: 'acme-drain-fixture', session: false },
      ],
    })
    const { code, output } = await discover(fake.origin)
    expect(code).toBe(0)
    expect(output).toMatch(/providers: 2 registered, 1 can sign in/)
    expect(output).not.toMatch(/acme|single sign-on|basic/i)
    expect(output).not.toContain(new URL(fake.origin).hostname)
    expect(output).not.toContain(String(fake.port))
    expect(output).toContain('origin: http://[redacted]')
    // Nothing long and opaque: no token, ticket or id.
    expect(output).not.toMatch(/[A-Za-z0-9_-]{24,}/)
  })

  it('reads no file and sends no credential when the command line names one', async () => {
    const fake = await fakeHermes()
    const errors: string[] = []
    const lines: string[] = []
    const code = await main(
      [
        '--origin',
        fake.origin,
        '--discover',
        '--token-file',
        '/nonexistent/cindl-fixture/access-token',
        '--cookie-file',
        '/nonexistent/cindl-fixture/cookie-header',
      ],
      { out: (line) => lines.push(line), err: (line) => errors.push(line) },
    )
    expect(code).toBe(0)
    expect(errors).toEqual([
      'note: --discover reads no file and sends no credential; ignoring it',
    ])
    expect(requests(fake)).toEqual(PUBLIC_READS)
    expect(
      await main(['--discover'], { out: () => undefined, err: () => undefined }),
    ).toBe(2)
  })
})
