import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CindlError } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { hermesReasonOf, RestClient, rpcError, type FetchLike } from '../src/index.ts'
import { bearerRest, captureLog, fakeHermes, timers } from './harness.ts'

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as CindlError,
  )

/** A throwaway HTTP server on 127.0.0.1; returns its origin. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })

describe('RestClient: the origin pin', () => {
  it('never follows a redirect, so no request leaves the Hermes origin', async () => {
    const reached: string[] = []
    const elsewhere = createServer((req, res) => {
      reached.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ version: '0.22.5' }))
    })
    const redirecting = createServer((_req, res) => {
      res.writeHead(302, { Location: `${target}/api/status` })
      res.end()
    })
    const target = await listen(elsewhere)
    const origin = await listen(redirecting)
    try {
      const rest = new RestClient({
        origin,
        fetch: (url, init) => fetch(url, init),
        timers,
        auth: { kind: 'cookie' },
      })
      expect(await errorOf(rest.status())).toBeInstanceOf(CindlError)
      expect(reached).toEqual([])
    } finally {
      await closeServer(elsewhere)
      await closeServer(redirecting)
    }
  })
})

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

  it('keeps Hermes prose out of error details and shows only machine tokens', async () => {
    const prose =
      'Could not write SOUL.md: [Errno 13] /srv/hermes-fixture/.hermes/SOUL.md'
    const rest = (body: unknown, status: number) =>
      new RestClient({
        origin: 'https://hermes.example.test',
        fetch: () => Promise.resolve(Response.json(body, { status })),
        timers,
        auth: { kind: 'none' },
      })
    const refused = await errorOf(rest({ detail: prose }, 500).status())
    expect(refused).toMatchObject({
      code: 'internal',
      detail: 'GET /api/status: HTTP 500',
    })
    expect(JSON.stringify(refused.toJSON())).not.toContain('/srv/')
    // The adapter can still classify what Hermes said; it never travels with the error.
    expect(hermesReasonOf(refused)).toBe(prose)
    const conflict = await errorOf(rest({ detail: 'revision_conflict' }, 409).status())
    expect(conflict.detail).toBe('GET /api/status: HTTP 409 (revision_conflict)')
    const rpc = rpcError({ code: 5000, message: `boom at ${prose}` }, 'session.title')
    expect(rpc).toMatchObject({ code: 'unavailable', detail: 'session.title: 5000' })
    expect(hermesReasonOf(rpc)).toContain('/srv/')
  })

  it('refuses a learning id that is not a fingerprinted memory entry before any request', async () => {
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
    for (const id of ['memory:memory:0', 'skill:fixture-notes', 'memory:memory:0:XYZ'])
      for (const attempt of [
        () => rest.learningNode(id),
        () => rest.writeLearningNode(id, 'text (fixture)'),
        () => rest.deleteLearningNode(id),
      ])
        expect((await errorOf(attempt())).code).toBe('invalid')
    expect(calls).toBe(0)
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

describe('RestClient: cookie sign-out (POST /auth/logout)', () => {
  /** A fetch that answers every request with `answer`, keeping what was asked. */
  function answering(answer: () => Response) {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetchLike: FetchLike = (url, init) => {
      seen.push({ url, init })
      return Promise.resolve(answer())
    }
    const rest = new RestClient({
      origin: 'https://hermes.example.test',
      fetch: fetchLike,
      timers,
      auth: { kind: 'cookie' },
    })
    return { rest, seen }
  }

  it("posts with the browser's cookie and takes Hermes's redirect to /login as done", async () => {
    // A browser shows a manual redirect as an opaque one: status 0, no Location.
    const opaque = {
      type: 'opaqueredirect',
      status: 0,
      ok: false,
      text: () => Promise.resolve(''),
    }
    const browser = answering(() => opaque as unknown as Response)
    await browser.rest.logout()
    expect(browser.seen).toHaveLength(1)
    const [request] = browser.seen
    expect(request?.url).toBe('https://hermes.example.test/auth/logout')
    expect(request?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
    })
    expect(new Headers(request?.init.headers).has('Authorization')).toBe(false)
    // Node and Electron's main process see the 302 itself.
    const fake = await fakeHermes()
    await new RestClient({
      origin: fake.origin,
      fetch: (url, init) => fetch(url, init),
      timers,
      auth: { kind: 'cookie' },
    }).logout()
    expect(fake.calls.filter((c) => c.name === 'POST /auth/logout')).toHaveLength(1)
  })

  it('refuses anything else as a confirmation, a 200 included', async () => {
    const codeFor = async (status: number) =>
      (await errorOf(answering(() => new Response('{}', { status })).rest.logout())).code
    expect(await codeFor(200)).toBe('protocol')
    expect(await codeFor(404)).toBe('not-found')
    expect(await codeFor(500)).toBe('internal')
    expect(await codeFor(503)).toBe('unavailable')
  })
})
