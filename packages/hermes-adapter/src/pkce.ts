/**
 * RFC 7636 / RFC 8252 helpers for the Hermes native sign-in flow, matching
 * hermes_cli/dashboard_auth/routes.py at v0.22.5:
 *
 *   GET  /auth/native/authorize ?provider&code_challenge&code_challenge_method=S256&redirect_uri&state
 *        -> system browser signs in -> redirect_uri?code=...&state=...
 *   POST /auth/native/token   {code, code_verifier}      -> bearer token set (code is single use)
 *   POST /auth/native/refresh {refresh_token, provider?} -> rotated set, or 401 session_expired
 *
 * Hermes accepts only http:// loopback IP literal redirects (127.0.0.1 or ::1),
 * so every platform needs a short-lived loopback listener. Do not relax this.
 */

export interface CryptoProvider {
  randomBytes(length: number): Uint8Array
  sha256(data: Uint8Array): Promise<Uint8Array>
}

/** WebCrypto provider for browsers, Electron and Node. Android injects expo-crypto. */
export function webCryptoProvider(crypto: Crypto = globalThis.crypto): CryptoProvider {
  return {
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    sha256: async (data) =>
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>),
      ),
  }
}

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

export async function createPkcePair(crypto: CryptoProvider): Promise<PkcePair> {
  // 32 random bytes -> 43 base64url characters, the RFC 7636 minimum length.
  const verifier = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(await crypto.sha256(new TextEncoder().encode(verifier)))
  return { verifier, challenge, method: 'S256' }
}

export function createState(crypto: CryptoProvider): string {
  return base64Url(crypto.randomBytes(24))
}

/**
 * Mirror of the server's `_validate_loopback_redirect_uri`: returns the
 * canonical URI or throws. Rejects `localhost`, https, custom schemes,
 * fragments, userinfo, backslashes, control characters and non-canonical
 * authorities, exactly as Hermes v0.22.5 does.
 */
export function canonicalLoopbackRedirect(raw: string): string {
  if (!raw) throw new Error('redirect_uri required')
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes('\\'))
    throw new Error('redirect_uri must be a canonical loopback URL')
  if (raw.includes('#')) throw new Error('redirect_uri must not contain a fragment')
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(\/[^?]*)?(\?.*)?$/.exec(
    raw,
  )
  if (!match)
    throw new Error('redirect_uri host must be http://127.0.0.1 or http://[::1]')
  const [, host, port, path, query] = match
  if (port !== undefined) {
    const number = Number(port)
    if (String(number) !== port || number < 1 || number > 65535)
      throw new Error('redirect_uri must use a canonical loopback authority')
  }
  return `http://${host}${port === undefined ? '' : `:${port}`}${path ?? '/'}${query ?? ''}`
}

export interface AuthorizeRequest {
  origin: string
  redirectUri: string
  pkce: PkcePair
  state: string
  provider?: string
}

export function buildAuthorizeUrl(request: AuthorizeRequest): string {
  const url = new URL('/auth/native/authorize', request.origin)
  if (request.provider) url.searchParams.set('provider', request.provider)
  url.searchParams.set('code_challenge', request.pkce.challenge)
  url.searchParams.set('code_challenge_method', request.pkce.method)
  url.searchParams.set('redirect_uri', canonicalLoopbackRedirect(request.redirectUri))
  url.searchParams.set('state', request.state)
  return url.toString()
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type CallbackResult =
  | { ok: true; code: string }
  | {
      ok: false
      reason: 'state-mismatch' | 'missing-code' | 'provider-error'
      detail?: string
    }

/** Parse the loopback callback. Only a matching `state` yields a code. */
export function parseCallback(
  callbackUrl: string,
  expectedState: string,
): CallbackResult {
  // An empty expected state would accept a callback that carries no state at all.
  if (!expectedState) return { ok: false, reason: 'state-mismatch' }
  const url = new URL(callbackUrl, 'http://127.0.0.1')
  const state = url.searchParams.get('state') ?? ''
  if (!timingSafeEqual(state, expectedState))
    return { ok: false, reason: 'state-mismatch' }
  const error = url.searchParams.get('error')
  if (error) return { ok: false, reason: 'provider-error', detail: error.slice(0, 200) }
  const code = url.searchParams.get('code')
  if (!code) return { ok: false, reason: 'missing-code' }
  return { ok: true, code }
}

/** Token set returned by /auth/native/token and /auth/native/refresh. */
export interface NativeTokenSet {
  access_token: string
  refresh_token: string
  token_type: string
  expires_at: number
  provider: string
  user_id: string
}

export function isNativeTokenSet(value: unknown): value is NativeTokenSet {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.access_token === 'string' &&
    typeof v.refresh_token === 'string' &&
    typeof v.token_type === 'string' &&
    typeof v.expires_at === 'number' &&
    typeof v.provider === 'string' &&
    typeof v.user_id === 'string'
  )
}
