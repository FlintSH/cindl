/**
 * TEST-ONLY fake of Hermes v0.22.5 dashboard auth (hermes_cli/dashboard_auth).
 * Every identity, credential and token here is SYNTHETIC and generated per
 * test run. Ports the behaviour Cindl depends on: single-use 30 s WebSocket
 * tickets, RFC 8252 native codes with real S256 PKCE verification (code
 * consumed before the check), refresh-token rotation, and the loopback
 * redirect validator.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface FakeClock {
  /** Milliseconds, like Date.now(). */
  now(): number
}

/** The one synthetic account of the fake. */
export const FIXTURE_OWNER = {
  user_id: 'fixture-owner',
  email: 'owner@example.test',
  display_name: 'Fixture Owner (synthetic)',
  org_id: '',
  provider: 'basic',
} as const

/** Synthetic password-login credentials. Not a secret. */
export const FIXTURE_LOGIN = {
  username: 'fixture-owner',
  password: 'fixture-password-not-a-secret',
} as const

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export interface FakeSession {
  accessToken: string
  refreshToken: string
  /** Unix seconds. */
  expiresAt: number
  refreshExpiresAt: number
  provider: string
  userId: string
}

interface Pending {
  challenge: string
  redirectUri: string
  clientState: string
  expiresAt: number
}

interface IssuedCode {
  challenge: string
  session: FakeSession
  expiresAt: number
}

export interface TicketInfo {
  userId: string
  provider: string
  /** Display tickets (`bot-desktop`) carry the viewer id and are refused as logins. */
  viewerId?: string
}

const s256 = (verifier: string) =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class FakeAuth {
  readonly #clock: FakeClock
  accessTtlSeconds = 12 * 3600
  refreshTtlSeconds = 30 * 86400
  ticketTtlSeconds = 30
  /** Simulate the auth provider being unreachable during refresh (503). */
  refreshUnavailable = false
  readonly #byAccess = new Map<string, FakeSession>()
  readonly #byRefresh = new Map<string, FakeSession>()
  /** Rotations replayed to their refresh token for 30 s (refresh_singleflight.py:24-28). */
  readonly #rotated = new Map<string, { until: number; session: FakeSession }>()
  readonly #tickets = new Map<string, { expiresAt: number; info: TicketInfo }>()
  readonly #pending = new Map<string, Pending>()
  readonly #codes = new Map<string, IssuedCode>()

  constructor(clock: FakeClock) {
    this.#clock = clock
  }

  #seconds(): number {
    return Math.floor(this.#clock.now() / 1000)
  }

  mintSession(): FakeSession {
    const now = this.#seconds()
    const session: FakeSession = {
      accessToken: randomToken(),
      refreshToken: randomToken(),
      expiresAt: now + this.accessTtlSeconds,
      refreshExpiresAt: now + this.refreshTtlSeconds,
      provider: FIXTURE_OWNER.provider,
      userId: FIXTURE_OWNER.user_id,
    }
    this.#byAccess.set(session.accessToken, session)
    this.#byRefresh.set(session.refreshToken, session)
    return session
  }

  verifyAccess(token: string | undefined): FakeSession | undefined {
    if (!token) return undefined
    const session = this.#byAccess.get(token)
    if (!session || session.expiresAt <= this.#seconds()) return undefined
    return session
  }

  /**
   * Rotate, as Hermes's password provider does (basic/__init__.py:157-163):
   * its tokens are signed and stateless, so nothing is spent. The presented
   * refresh token and its access token keep working until they expire, and
   * the refresh token rotates again later. Within 30 s Hermes hands the same
   * refresh token the same rotated session instead, as it coalesces a burst
   * of requests that all carried it (refresh_singleflight.py:1-11, 53-75; the
   * cookie gate and the native route share it).
   */
  refresh(refreshToken: string): FakeSession | undefined {
    const now = this.#seconds()
    for (const [token, replay] of this.#rotated)
      if (replay.until <= now) this.#rotated.delete(token)
    const replay = this.#rotated.get(refreshToken)
    if (replay) return replay.session
    const session = this.#byRefresh.get(refreshToken)
    if (!session || session.refreshExpiresAt <= now) return undefined
    const rotated = this.mintSession()
    this.#rotated.set(refreshToken, { until: now + 30, session: rotated })
    return rotated
  }

  /** Test control: every current access token expires now (refresh tokens stay valid). */
  expireAccessTokens(): void {
    for (const session of this.#byAccess.values()) session.expiresAt = this.#seconds() - 1
  }

  /** Test control: forget every session, as a provider secret rotation would. */
  revokeAll(): void {
    this.#byAccess.clear()
    this.#byRefresh.clear()
    this.#rotated.clear()
  }

  mintTicket(info: TicketInfo): string {
    const ticket = randomToken()
    this.#tickets.set(ticket, {
      expiresAt: this.#seconds() + this.ticketTtlSeconds,
      info,
    })
    return ticket
  }

  /** Single use: the ticket is gone after this call whatever the outcome. */
  consumeTicket(ticket: string): TicketInfo | undefined {
    const entry = this.#tickets.get(ticket)
    this.#tickets.delete(ticket)
    if (!entry || entry.expiresAt < this.#seconds()) return undefined
    return entry.info
  }

  registerPending(challenge: string, redirectUri: string, clientState: string): string {
    const brokerState = randomToken()
    this.#pending.set(brokerState, {
      challenge,
      redirectUri,
      clientState,
      expiresAt: this.#seconds() + 600,
    })
    return brokerState
  }

  /** Mint the one-time loopback code (120 s) and the redirect target. */
  completePending(brokerState: string): string | undefined {
    const pending = this.#pending.get(brokerState)
    this.#pending.delete(brokerState)
    if (!pending || pending.expiresAt < this.#seconds()) return undefined
    const code = randomToken()
    this.#codes.set(code, {
      challenge: pending.challenge,
      session: this.mintSession(),
      expiresAt: this.#seconds() + 120,
    })
    const separator = pending.redirectUri.includes('?') ? '&' : '?'
    const query = new URLSearchParams({ code, state: pending.clientState })
    return `${pending.redirectUri}${separator}${query.toString()}`
  }

  /** native_flow.redeem_code: popped BEFORE the PKCE check, so a wrong verifier burns the code. */
  redeem(code: string, verifier: string): FakeSession | undefined {
    const issued = this.#codes.get(code)
    this.#codes.delete(code)
    if (!issued || issued.expiresAt < this.#seconds()) return undefined
    if (!equal(issued.challenge, s256(verifier))) return undefined
    return issued.session
  }
}

const LOOPBACK_HOSTS: Record<string, string> = {
  '127.0.0.1': '127.0.0.1',
  '::1': '[::1]',
}

/**
 * Port of hermes_cli/dashboard_auth/routes.py `_validate_loopback_redirect_uri`
 * (v0.22.5, :242-276) with Python `urlparse` semantics. Throws an Error whose
 * message is the server's 400 detail.
 */
export function validateLoopbackRedirect(raw: string): string {
  if (!raw) throw new Error('redirect_uri required')
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 0x7f || code <= 0x20 || code === 0x7f || ch === '\\')
      throw new Error('native redirect_uri must use a canonical loopback URL')
  }
  const schemeEnd = raw.indexOf(':')
  const scheme = schemeEnd > 0 ? raw.slice(0, schemeEnd).toLowerCase() : ''
  if (scheme !== 'http')
    throw new Error('native redirect_uri must be http:// on the loopback interface')
  if (raw.includes('#'))
    throw new Error('native redirect_uri must not contain a fragment')
  const rest = raw.slice(schemeEnd + 1)
  if (!rest.startsWith('//'))
    throw new Error(
      'native redirect_uri host must be a loopback IP literal (127.0.0.1 / ::1)',
    )
  const afterSlashes = rest.slice(2)
  const netlocEnd = afterSlashes.search(/[/?#]/)
  const netloc = netlocEnd < 0 ? afterSlashes : afterSlashes.slice(0, netlocEnd)
  const tail = netlocEnd < 0 ? '' : afterSlashes.slice(netlocEnd)
  if (netloc.includes('@'))
    throw new Error('native redirect_uri must not contain userinfo')
  let host: string
  let portText: string | undefined
  if (netloc.startsWith('[')) {
    const close = netloc.indexOf(']')
    if (close < 0)
      throw new Error('native redirect_uri must use a canonical loopback URL')
    host = netloc.slice(1, close).toLowerCase()
    const after = netloc.slice(close + 1)
    if (after) {
      if (!after.startsWith(':'))
        throw new Error('native redirect_uri must use a canonical loopback URL')
      portText = after.slice(1)
    }
  } else {
    const colon = netloc.indexOf(':')
    host = (colon < 0 ? netloc : netloc.slice(0, colon)).toLowerCase()
    if (colon >= 0) portText = netloc.slice(colon + 1)
  }
  let port: number | undefined
  if (portText !== undefined) {
    if (!/^[0-9]+$/.test(portText) || Number(portText) > 65535)
      throw new Error('native redirect_uri must use a canonical loopback URL')
    port = Number(portText)
  }
  const canonicalHost = LOOPBACK_HOSTS[host]
  if (!canonicalHost)
    throw new Error(
      'native redirect_uri host must be a loopback IP literal (127.0.0.1 / ::1)',
    )
  const canonicalNetloc = canonicalHost + (port === undefined ? '' : `:${port}`)
  if (netloc !== canonicalNetloc)
    throw new Error('native redirect_uri must use a canonical loopback authority')
  const path = tail.startsWith('/') ? tail : `/${tail}`
  return `http://${canonicalNetloc}${path}`
}
