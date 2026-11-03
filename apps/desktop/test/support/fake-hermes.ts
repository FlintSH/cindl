/**
 * A local stand-in for the `hermes serve` v0.22.5 native sign-in endpoints,
 * bound to 127.0.0.1. It enforces what the real server does at that version
 * (S256 PKCE, loopback-only redirect URIs, single-use codes, rotating refresh
 * tokens, 401 on an unknown refresh token) so the desktop flow is tested
 * against behaviour, not against a mock of itself. All values are synthetic.
 */
import { canonicalLoopbackRedirect } from '@cindl/hermes-adapter'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const b64url = (bytes: Buffer) => bytes.toString('base64url')

export interface FakeHermes {
  origin: string
  /** "METHOD /path" for every request received. */
  requests: string[]
  /** JSON bodies posted to the token and refresh endpoints. */
  bodies: Array<Record<string, unknown>>
  /** Make the next authorize redirect carry `error=` instead of a code. */
  denyNext(): void
  /** Answer the next token or refresh request with this status. */
  failNext(status: number): void
  /** Lifetime of issued access tokens, in seconds. */
  setLifetime(seconds: number): void
  /** Hold the next refresh response until the returned function is called. */
  holdNextRefresh(): () => void
  issued: { access: string[]; refresh: string[] }
  close(): Promise<void>
}

export async function startFakeHermes(): Promise<FakeHermes> {
  const codes = new Map<string, { challenge: string; used: boolean }>()
  const liveRefresh = new Set<string>()
  const requests: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const issued = { access: [] as string[], refresh: [] as string[] }
  let deny = false
  let failStatus: number | undefined
  let lifetime = 12 * 3600
  let hold: Promise<void> | undefined

  const tokenSet = () => {
    const access = `synthetic-access-${b64url(randomBytes(12))}`
    const refresh = `synthetic-refresh-${b64url(randomBytes(12))}`
    issued.access.push(access)
    issued.refresh.push(refresh)
    liveRefresh.add(refresh)
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + lifetime,
      provider: 'basic',
      user_id: 'owner (synthetic)',
    }
  }

  const readJson = async (request: http.IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(`${request.method} ${url.pathname}`)
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    void (async () => {
      if (request.method === 'GET' && url.pathname === '/auth/native/authorize') {
        const query = url.searchParams
        let redirect: string
        try {
          redirect = canonicalLoopbackRedirect(query.get('redirect_uri') ?? '')
        } catch {
          return json(400, { detail: 'invalid redirect_uri' })
        }
        const challenge = query.get('code_challenge') ?? ''
        const state = query.get('state') ?? ''
        if (
          query.get('code_challenge_method') !== 'S256' ||
          challenge.length < 43 ||
          !state
        )
          return json(400, { detail: 'invalid request' })
        const target = new URL(redirect)
        if (deny) {
          deny = false
          target.searchParams.set('error', 'access_denied')
        } else {
          const code = `synthetic-code-${b64url(randomBytes(12))}`
          codes.set(code, { challenge, used: false })
          target.searchParams.set('code', code)
        }
        target.searchParams.set('state', state)
        response.writeHead(302, { Location: target.href })
        return response.end()
      }
      if (request.method === 'POST' && url.pathname === '/auth/native/token') {
        const body = await readJson(request)
        bodies.push(body)
        if (failStatus !== undefined) {
          const status = failStatus
          failStatus = undefined
          return json(status, { detail: 'synthetic failure' })
        }
        const entry = codes.get(String(body.code))
        const verifier = String(body.code_verifier)
        if (!entry || entry.used) return json(400, { detail: 'invalid_grant' })
        entry.used = true
        if (b64url(createHash('sha256').update(verifier).digest()) !== entry.challenge)
          return json(400, { detail: 'invalid_grant' })
        return json(200, tokenSet())
      }
      if (request.method === 'POST' && url.pathname === '/auth/native/refresh') {
        const body = await readJson(request)
        bodies.push(body)
        if (hold) {
          const held = hold
          hold = undefined
          await held
        }
        if (failStatus !== undefined) {
          const status = failStatus
          failStatus = undefined
          return json(status, { detail: 'synthetic failure' })
        }
        const token = String(body.refresh_token)
        if (!liveRefresh.delete(token)) return json(401, { detail: 'session_expired' })
        return json(200, tokenSet())
      }
      json(404, { detail: 'not found' })
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    bodies,
    issued,
    denyNext: () => {
      deny = true
    },
    failNext: (status) => {
      failStatus = status
    },
    setLifetime: (seconds) => {
      lifetime = seconds
    },
    holdNextRefresh: () => {
      let release: () => void = () => undefined
      hold = new Promise<void>((resolve) => (release = resolve))
      return release
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** The system browser, reduced to what sign-in needs: follow Hermes's redirect once. */
export async function browserFollowsRedirect(authorizeUrl: string): Promise<void> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (!location) throw new Error(`authorize answered ${response.status}`)
  await fetch(location)
}

/** A raw GET with full control over the Host header (fetch does not allow that). */
export function rawGet(
  port: number,
  target: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: target, method, headers, agent: false },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    request.on('error', reject)
    request.end()
  })
}
