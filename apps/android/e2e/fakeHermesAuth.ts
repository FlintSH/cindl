import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { base64Url, canonicalLoopbackRedirect } from '@cindl/hermes-adapter'

/**
 * A SYNTHETIC stand-in for `hermes serve`'s native sign-in routes at v0.22.5
 * (pinned surface in packages/hermes-adapter): GET /auth/native/authorize
 * redirects to the app's loopback listener with a one-time code, POST
 * /auth/native/token checks the PKCE verifier (S256) and issues a fake token
 * set, POST /auth/native/refresh rotates it. It is a test double for the
 * emulator tests, never evidence about a real Hermes server.
 *
 * `hold()` keeps the next authorize responses pending until `release()`, so a
 * test can kill the app while the browser waits. The event log never holds
 * codes, verifiers or tokens.
 */
export interface AuthEvent {
  kind: 'authorize' | 'token' | 'refresh' | 'other'
  status: number
  detail: Record<string, string | boolean>
}

export interface FakeHermesAuth {
  origin: string
  port: number
  events: AuthEvent[]
  hold: () => void
  release: () => number
  waitFor: (kind: AuthEvent['kind'], count: number, timeoutMs: number) => Promise<boolean>
  close: () => Promise<void>
}

export async function startFakeHermesAuth(port = 0): Promise<FakeHermesAuth> {
  const codes = new Map<string, { challenge: string; used: boolean }>()
  const refreshable = new Set<string>()
  const events: AuthEvent[] = []
  const pending: Array<{ response: ServerResponse; location: string }> = []
  const listeners = new Set<() => void>()
  let holding = false
  let issued = 0

  const record = (event: AuthEvent) => {
    events.push(event)
    for (const notify of listeners) notify()
  }
  const send = (response: ServerResponse, status: number, body: unknown, headers = {}) =>
    response
      .writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...headers,
      })
      .end(JSON.stringify(body))
  const tokenSet = () => {
    issued += 1
    const refresh = `synthetic-refresh-${issued}-${randomBytes(6).toString('hex')}`
    refreshable.add(refresh)
    return {
      access_token: `synthetic-access-${issued}-${randomBytes(6).toString('hex')}`,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      provider: 'basic',
      user_id: 'synthetic-owner',
    }
  }
  const readJson = async (request: IncomingMessage) => {
    let text = ''
    for await (const chunk of request) text += String(chunk)
    try {
      return JSON.parse(text) as Record<string, string>
    } catch {
      return {}
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/auth/native/authorize') {
        const params = url.searchParams
        const state = params.get('state')
        const challenge = params.get('code_challenge')
        let redirect: string | undefined
        try {
          redirect = canonicalLoopbackRedirect(params.get('redirect_uri') ?? '')
        } catch {
          redirect = undefined
        }
        const detail = {
          redirectUri: redirect ?? 'invalid',
          challengeMethod: params.get('code_challenge_method') ?? '',
          hasChallenge: Boolean(challenge),
          hasState: Boolean(state),
          held: holding,
        }
        if (!redirect || detail.challengeMethod !== 'S256' || !challenge || !state) {
          record({ kind: 'authorize', status: 400, detail })
          return send(response, 400, { detail: 'invalid request' })
        }
        const code = `synthetic-code-${randomBytes(8).toString('hex')}`
        codes.set(code, { challenge, used: false })
        const location = new URL(redirect)
        location.searchParams.set('code', code)
        location.searchParams.set('state', state)
        record({ kind: 'authorize', status: 302, detail })
        if (holding) {
          pending.push({ response, location: location.href })
          return
        }
        return send(response, 302, {}, { location: location.href })
      }
      if (request.method === 'POST' && url.pathname === '/auth/native/token') {
        const body = await readJson(request)
        const entry = codes.get(body.code ?? '')
        const verifierMatches =
          entry !== undefined &&
          base64Url(
            createHash('sha256')
              .update(body.code_verifier ?? '')
              .digest(),
          ) === entry.challenge
        const ok = entry !== undefined && !entry.used && verifierMatches
        if (entry) entry.used = true
        record({
          kind: 'token',
          status: ok ? 200 : 400,
          detail: { codeKnown: entry !== undefined, verifierMatches, issued: ok },
        })
        return ok
          ? send(response, 200, tokenSet())
          : send(response, 400, { detail: 'invalid_grant' })
      }
      if (request.method === 'POST' && url.pathname === '/auth/native/refresh') {
        const body = await readJson(request)
        const ok = refreshable.delete(body.refresh_token ?? '')
        record({ kind: 'refresh', status: ok ? 200 : 401, detail: { rotated: ok } })
        return ok
          ? send(response, 200, tokenSet())
          : send(response, 401, { detail: 'session_expired' })
      }
      record({ kind: 'other', status: 404, detail: { path: url.pathname } })
      return send(response, 404, {})
    })()
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const actual = (server.address() as AddressInfo).port

  return {
    origin: `http://127.0.0.1:${actual}`,
    port: actual,
    events,
    hold: () => {
      holding = true
    },
    release: () => {
      holding = false
      const released = pending.splice(0)
      for (const { response, location } of released) {
        // The browser may have given up on the request (tab closed, app killed).
        if (response.destroyed || response.socket?.destroyed !== false) continue
        response.on('error', () => undefined)
        send(response, 302, {}, { location })
      }
      return released.length
    },
    waitFor: (kind, count, timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const done = (result: boolean) => {
          clearTimeout(timer)
          listeners.delete(check)
          resolve(result)
        }
        const check = () => {
          if (events.filter((event) => event.kind === kind).length >= count) done(true)
        }
        const timer = setTimeout(() => done(false), timeoutMs)
        listeners.add(check)
        check()
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const { response } of pending.splice(0)) response.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
