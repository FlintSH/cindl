// Read-only compatibility probe for an operator's own `hermes serve`.
//
//   node packages/hermes-adapter/scripts/live-probe.ts --origin https://hermes.example.test --token-file ./access-token
//   node packages/hermes-adapter/scripts/live-probe.ts --origin https://hermes.example.test --cookie-file ./cookie-header
//
// It performs only: GET /api/status, GET /api/auth/me, POST /api/auth/ws-ticket
// (one single-use ticket), the /api/ws handshake (gateway.ready,
// client.capabilities, gateway.capabilities or runtime.describe) and one
// session.list whose rows are counted, never printed. It never prints tokens,
// tickets, cookies, titles or ids, never submits a prompt and never changes
// anything. It attaches to no session, so no approval or question reaches it
// (Hermes sends those to a session's attached clients), and it does not
// advertise `server_requests` either.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { HermesOrigin } from '@cindl/contracts'
import { HermesConnection, type ConnectionState } from '../src/connection.ts'
import { safeText } from '../src/diagnostics.ts'
import { isBaselineVersion } from '../src/compat.ts'
import { negotiateCapabilities } from '../src/negotiate.ts'
import type { FetchLike, SocketFactory, SocketLike, Timers } from '../src/platform.ts'
import { redactText, redactUrl } from '../src/redact.ts'
import { RestClient } from '../src/rest.ts'

export interface ProbeOptions {
  origin: string
  token?: string
  /** A `Cookie` request header value for a web session (read from a file the operator provides). */
  cookieHeader?: string
}

export interface ProbeIo {
  out(line: string): void
  fetch?: FetchLike
  socketFactory?: SocketFactory
}

const timers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Node's built-in WebSocket (undici) shaped as the adapter's SocketLike. */
const nodeWebSocket: SocketFactory = (url, protocols) => {
  const ws = new WebSocket(url, protocols)
  const like: SocketLike = {
    get readyState() {
      return ws.readyState
    },
    get protocol() {
      return ws.protocol
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.onopen = (event) => like.onopen?.(event)
  ws.onmessage = (event) => like.onmessage?.({ data: event.data as unknown })
  ws.onclose = (event) => like.onclose?.({ code: event.code, reason: event.reason })
  ws.onerror = (event) => like.onerror?.(event)
  return like
}

/** Exit codes: 0 compatible, 2 usage, 3 not signed in, 4 unreachable, 5 incompatible. */
export async function runProbe(options: ProbeOptions, io: ProbeIo): Promise<number> {
  const say = (line: string) => io.out(redactText(line))
  // The rule sign-in uses (https, or plain http only on 127.0.0.1 or [::1]),
  // checked before any request so a token or cookie never travels in clear
  // text. The refused value is not echoed: it may carry credentials.
  const parsed = HermesOrigin.safeParse(options.origin)
  if (!parsed.success) {
    say(
      `error: --origin ${parsed.error.issues[0]?.message ?? 'is not usable.'} For example https://hermes.example.test`,
    )
    return 2
  }
  const origin = parsed.data
  const baseFetch = io.fetch ?? ((url, init) => fetch(url, init))
  const cookieHeader = options.cookieHeader
  const probeFetch: FetchLike = cookieHeader
    ? (url, init) =>
        baseFetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), Cookie: cookieHeader },
        })
    : baseFetch
  const rest = new RestClient({
    origin,
    fetch: probeFetch,
    timers,
    auth: options.token
      ? {
          kind: 'bearer',
          accessToken: () => Promise.resolve(options.token),
          // The probe never rotates tokens.
          refresh: () => Promise.resolve(false),
        }
      : { kind: 'cookie' },
  })

  say('Hermes live probe (read-only)')
  say(`origin: ${redactUrl(origin)}`)
  let status
  try {
    status = await rest.status()
  } catch (error) {
    say(`GET /api/status failed: ${describe(error)}`)
    return 4
  }
  say(
    `version: ${status.version ?? 'unknown'} (verified baseline v0.22.5: ${isBaselineVersion(status.version) ? 'yes' : 'no, untested'})`,
  )
  say(
    `auth: required=${String(status.auth_required)} flows=${(status.auth_flows ?? []).join(',') || 'none'} providers=${status.auth_providers?.length ?? 0}`,
  )
  if (status.auth_required === false) {
    say(
      'result: incompatible. Hermes runs in loopback-token mode; Cindl needs a sign-in provider and never reads the per-process token.',
    )
    return 5
  }
  try {
    const me = await rest.me()
    say(`identity: signed in (provider ${safeText(me.provider, 40)})`)
  } catch (error) {
    say(`GET /api/auth/me failed: ${describe(error)}`)
    return 3
  }

  const outcome = await new Promise<{ state: ConnectionState; sessions?: number }>(
    (resolve) => {
      let finished = false
      const connection = new HermesConnection({
        origin,
        rest,
        socketFactory: io.socketFactory ?? nodeWebSocket,
        timers,
        advertiseServerRequests: false,
        callbacks: {
          onReady: async (handshake) => {
            let sessions: number | undefined
            if (handshake.authority === 'legacy-sidecar-v8') {
              const result = (await connection
                .request('session.list', { limit: 200 })
                .catch(() => undefined)) as { sessions?: unknown[] } | undefined
              sessions = Array.isArray(result?.sessions)
                ? result.sessions.length
                : undefined
            }
            finish({ phase: 'online', handshake }, sessions)
          },
          onEvent: () => undefined,
          // Never answered: the probe did not advertise server requests.
          onServerRequest: () => undefined,
          onState: (state) => {
            if (
              state.phase === 'reconnecting' ||
              state.phase === 'signed-out' ||
              state.phase === 'incompatible'
            )
              finish(state)
          },
        },
      })
      // Callbacks only run after start(), when `connection` is initialised.
      function finish(state: ConnectionState, sessions?: number) {
        if (finished) return
        finished = true
        connection.stop()
        resolve(sessions === undefined ? { state } : { state, sessions })
      }
      connection.start()
    },
  )

  const { state } = outcome
  if (state.phase !== 'online') {
    const error = 'lastError' in state ? state.lastError : undefined
    say(`websocket: failed (${state.phase}${error ? `: ${describe(error)}` : ''})`)
    return state.phase === 'incompatible' ? 5 : state.phase === 'signed-out' ? 3 : 4
  }
  const handshake = state.handshake
  say('websocket: ok (ticket in subprotocol, server selected hermes-gateway-v1)')
  say(
    `gateway.ready: heartbeat=${String(handshake.heartbeat)} session_authority=${String(handshake.sessionAuthority)} replay_epoch=present`,
  )
  say(`authority: ${handshake.authority}`)
  say(`server requests Hermes may send: ${handshake.serverRequests.join(', ') || 'none'}`)
  say(`declines counted (4404): ${String(handshake.declinesNotShown)}`)
  if (handshake.perSessionExclusiveSubmit !== undefined)
    say(
      `gateway.capabilities: per_session_exclusive_submit=${String(handshake.perSessionExclusiveSubmit)}`,
    )
  if (handshake.runtime)
    say(
      `runtime.describe: ${handshake.runtime.capabilities.length} canonical capabilities`,
    )
  say(
    `sessions: ${outcome.sessions === undefined ? 'not counted' : `${outcome.sessions} stored`} (titles and ids are not shown)`,
  )
  const capabilities = negotiateCapabilities({
    checkedAt: new Date().toISOString(),
    signedIn: true,
    status,
    handshake,
  })
  say('capabilities (display not probed):')
  for (const capability of Object.values(capabilities))
    say(
      `  ${capability.id}: ${capability.state}${capability.reason ? ` (${capability.reason})` : ''}`,
    )
  say('result: compatible')
  return 0
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error)
    return safeText(`${String(error.code)}: ${String(error.message)}`, 200)
  return 'unexpected error'
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const origin = arg('--origin')
  const tokenFile = arg('--token-file')
  const cookieFile = arg('--cookie-file')
  if (!origin || (!tokenFile && !cookieFile) || (tokenFile && cookieFile)) {
    console.error(
      'usage: live-probe.ts --origin <url> (--token-file <path> | --cookie-file <path>)',
    )
    return 2
  }
  const raw = (await readFile((tokenFile ?? cookieFile) as string, 'utf8')).trim()
  let token: string | undefined
  if (tokenFile) {
    // A bare access token, or a stored token set with an access_token field.
    token = raw
    if (raw.startsWith('{')) {
      let parsed: { access_token?: unknown }
      try {
        parsed = JSON.parse(raw) as { access_token?: unknown }
      } catch {
        // Never echo the parser's message: it quotes the file's contents.
        console.error('error: the token file is not valid JSON')
        return 2
      }
      token = typeof parsed.access_token === 'string' ? parsed.access_token : undefined
    }
    if (!token) {
      console.error('error: the token file holds no access token')
      return 2
    }
  }
  return runProbe(
    { origin, ...(token ? { token } : {}), ...(cookieFile ? { cookieHeader: raw } : {}) },
    { out: (line) => console.log(line) },
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main(process.argv.slice(2))
