import { CindlError } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { RestClient, type FetchLike } from '../src/index.ts'
import { bearerRest, captureLog, fakeHermes, timers } from './harness.ts'

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as CindlError,
  )

describe('RestClient', () => {
  it('maps auth denial, missing things and bad input to Cindl codes', async () => {
    const fake = await fakeHermes()
    const cookieless = new RestClient({
      origin: fake.origin,
      fetch: (url, init) => fetch(url, init),
      timers,
      auth: { kind: 'cookie' },
    })
    expect((await errorOf(cookieless.me())).code).toBe('unauthenticated')
    const rest = bearerRest(fake, fake.signIn())
    expect((await errorOf(rest.skillContent('no-such-skill'))).code).toBe('not-found')
    expect((await errorOf(rest.soul('Not A Profile!'))).code).toBe('invalid')
    expect((await errorOf(rest.soul('ghost'))).code).toBe('not-found')
    expect((await errorOf(bearerRest(fake, () => 'not-a-token').me())).code).toBe(
      'unauthenticated',
    )
  })

  it('never sends the bearer to public endpoints', async () => {
    const fake = await fakeHermes()
    const seen: Array<{ url: string; authorization: string | undefined }> = []
    const recording: FetchLike = (url, init) => {
      seen.push({
        url,
        authorization: (init.headers as Record<string, string> | undefined)
          ?.Authorization,
      })
      return fetch(url, init)
    }
    const session = fake.signIn()
    const rest = new RestClient({
      origin: fake.origin,
      fetch: recording,
      timers,
      auth: {
        kind: 'bearer',
        accessToken: () => Promise.resolve(session.accessToken),
        refresh: () => Promise.resolve(false),
      },
    })
    await rest.status()
    await rest.providers()
    await rest.me()
    expect(seen.map((s) => [new URL(s.url).pathname, Boolean(s.authorization)])).toEqual([
      ['/api/status', false],
      ['/api/auth/providers', false],
      ['/api/auth/me', true],
    ])
  })

  it('times out a request Hermes never answers', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      )
    const rest = new RestClient({
      origin: 'https://hermes.example.test',
      fetch: hanging,
      timers,
      auth: { kind: 'none' },
      timeoutMs: 30,
    })
    expect((await errorOf(rest.status())).code).toBe('timeout')
  })

  it('reports a network failure as offline', async () => {
    const rest = new RestClient({
      origin: 'https://hermes.example.test',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      timers,
      auth: { kind: 'none' },
    })
    expect((await errorOf(rest.status())).code).toBe('offline')
  })

  it('keeps tickets, tokens and cookies out of error details and logs', async () => {
    const leaky = JSON.stringify({
      detail:
        'boom hermes-gateway-ticket.TICKETSECRET123 Authorization: bearer TOKENSECRET4567 hermes_session_at=COOKIESECRET89',
    })
    const log = captureLog()
    const rest = new RestClient({
      origin: 'https://hermes.example.test',
      fetch: () => Promise.resolve(new Response(leaky, { status: 400 })),
      timers,
      auth: { kind: 'none' },
      diagnostics: log.diagnostics,
    })
    const error = await errorOf(rest.status())
    const text = JSON.stringify(error.toJSON()) + log.text()
    for (const secret of ['TICKETSECRET123', 'TOKENSECRET4567', 'COOKIESECRET89'])
      expect(text).not.toContain(secret)
  })

  it('drops host paths and loopback-only status fields', async () => {
    const loopback = await fakeHermes({ mode: 'loopback' })
    const status = await new RestClient({
      origin: loopback.origin,
      fetch: (url, init) => fetch(url, init),
      timers,
      auth: { kind: 'none' },
    }).status()
    expect(status).toEqual({
      version: '0.22.5',
      release_date: '2026-10-28',
      auth_required: false,
      auth_providers: [],
      auth_flows: [],
    })
    const fake = await fakeHermes()
    const skill = await bearerRest(fake, fake.signIn()).skillContent('fixture-notes')
    expect(Object.keys(skill).sort()).toEqual(['content', 'name'])
  })

  it('refuses a session endpoint without credentials instead of calling it', async () => {
    let calls = 0
    const rest = new RestClient({
      origin: 'https://hermes.example.test',
      fetch: () => {
        calls++
        return Promise.reject(new Error('unreachable'))
      },
      timers,
      auth: { kind: 'none' },
    })
    expect((await errorOf(rest.me())).code).toBe('unauthenticated')
    expect(calls).toBe(0)
  })
})
