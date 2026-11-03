import type { KeyValueStore, LoopbackAuthorizer, SecretStore } from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  isNativeTokenSet,
  parseCallback,
  redactText,
  restEndpoints,
  type CryptoProvider,
  type NativeTokenSet,
} from '@cindl/hermes-adapter'
import type { Logger } from '../log.ts'
import {
  normalizeHermesOrigin,
  trustedStoredOrigin,
  usesSecureTransport,
} from './origin-policy.ts'

export { normalizeHermesOrigin } from './origin-policy.ts'

/**
 * Native (RFC 8252 + PKCE S256) sign-in to `hermes serve` v0.22.5, run in the
 * Electron main process:
 *
 *   GET  /auth/native/authorize  in the system browser, redirect to the loopback listener
 *   POST /auth/native/token      {code, code_verifier}  -> token set
 *   POST /auth/native/refresh    {refresh_token, provider} -> rotated token set
 *
 * Tokens go to the secret store only. Nothing here returns a token to the
 * renderer; `accessToken()` is for the main-process Hermes client. Sign-out
 * is local: Hermes v0.22.5 has no way to revoke native tokens it issued.
 */
export const ORIGIN_KEY = 'hermes.origin'
export const tokenKey = (origin: string) => `hermes.native-tokens:${origin}`

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

export interface NativeSession {
  origin: string
  provider: string
  userId: string
  /** Access token expiry, Unix milliseconds. */
  expiresAt: number
}

/**
 * Hermes reports `expires_at` as a Unix timestamp. Seconds are assumed (the
 * Python default); a value that is already in milliseconds is kept.
 */
export function expiresAtMs(expiresAt: number): number {
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt
}

const toSession = (origin: string, tokens: NativeTokenSet): NativeSession => ({
  origin,
  provider: tokens.provider,
  userId: tokens.user_id,
  expiresAt: expiresAtMs(tokens.expires_at),
})

export interface NativeAuthDeps {
  fetch: typeof globalThis.fetch
  crypto: CryptoProvider
  authorizer: LoopbackAuthorizer
  secrets: SecretStore
  kv: KeyValueStore
  /**
   * Main-owned confirmation of the origin (a native dialog in the app), asked
   * before the browser opens: the request to sign in may come from the
   * untrusted renderer.
   */
  confirmSignIn(origin: string): Promise<boolean>
  now?: () => number
  log?: Logger
  /** Called after a successful sign-in (e.g. to pin the WebSocket origin). */
  onSignedIn?(session: NativeSession): void
}

export function createNativeAuth(deps: NativeAuthDeps) {
  const now = deps.now ?? Date.now
  let refreshing: Promise<NativeTokenSet> | undefined
  /** Bumped by sign-in and sign-out: a refresh that started before must not write. */
  let generation = 0

  const post = async (origin: string, path: string, body: Record<string, string>) => {
    const url = new URL(path, origin)
    // Codes, verifiers and tokens never travel over plain http to another machine.
    if (!usesSecureTransport(url))
      throw new CindlError(
        'invalid',
        'Cindl only sends sign-in data to Hermes over https.',
      )
    let response: Response
    try {
      response = await deps.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      deps.log?.warn('Hermes sign-in request failed', error)
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new CindlError(
        timedOut ? 'timeout' : 'offline',
        `Cindl could not reach Hermes at ${origin}.`,
      )
    }
    let json: unknown
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
    return { status: response.status, json }
  }

  // The origin is stored inside the encrypted record, so a record moved to
  // another key (another origin) on disk is not used.
  const readTokens = async (origin: string): Promise<NativeTokenSet | undefined> => {
    const raw = await deps.secrets.get(tokenKey(origin))
    if (raw === undefined) return undefined
    try {
      const value: unknown = JSON.parse(raw)
      return isNativeTokenSet(value) && (value as { origin?: unknown }).origin === origin
        ? value
        : undefined
    } catch {
      return undefined
    }
  }
  const writeTokens = (origin: string, tokens: NativeTokenSet) =>
    deps.secrets.set(tokenKey(origin), JSON.stringify({ ...tokens, origin }))

  const exchange = async (origin: string, code: string, verifier: string) => {
    const { status, json } = await post(origin, restEndpoints.nativeToken.path, {
      code,
      code_verifier: verifier,
    })
    if (status >= 400 && status < 500)
      throw new CindlError(
        'unauthenticated',
        'Hermes did not accept this sign-in. Start it again.',
      )
    if (status !== 200)
      throw new CindlError('unavailable', 'Hermes could not complete sign-in right now.')
    if (!isNativeTokenSet(json))
      throw new CindlError('protocol', 'Hermes answered sign-in in an unexpected format.')
    return json
  }

  const refreshTokens = async (origin: string, current: NativeTokenSet) => {
    const started = generation
    const { status, json } = await post(origin, restEndpoints.nativeRefresh.path, {
      refresh_token: current.refresh_token,
      provider: current.provider,
    })
    // Signed out or signed in elsewhere meanwhile: never write the old session back.
    if (generation !== started)
      throw new CindlError('unauthenticated', 'Not signed in to Hermes on this device.')
    // v0.22.5 answers an expired or revoked refresh token with 401 session_expired.
    if (status === 401) {
      await deps.secrets.delete(tokenKey(origin))
      throw new CindlError(
        'unauthenticated',
        'Your Hermes sign-in on this device expired. Sign in again.',
      )
    }
    if (status !== 200)
      throw new CindlError(
        'unavailable',
        'Hermes could not refresh this sign-in right now.',
      )
    if (!isNativeTokenSet(json))
      throw new CindlError(
        'protocol',
        'Hermes answered a refresh in an unexpected format.',
      )
    // Refresh tokens rotate: the old one is dead once this returns.
    await writeTokens(origin, json)
    return json
  }

  /** The stored origin, re-checked: a file edited on disk cannot redirect tokens. */
  const storedOrigin = async () => trustedStoredOrigin(await deps.kv.get(ORIGIN_KEY))

  const signedIn = async () => {
    const origin = await storedOrigin()
    const tokens = origin === undefined ? undefined : await readTokens(origin)
    return origin === undefined || tokens === undefined ? undefined : { origin, tokens }
  }

  return {
    /** The last Hermes origin this device signed in to (kept after sign-out). */
    origin: storedOrigin,

    async session(): Promise<NativeSession | undefined> {
      const current = await signedIn()
      return current && toSession(current.origin, current.tokens)
    },

    /**
     * Runs the full native flow against `rawOrigin`. Resolves with session
     * metadata only; the tokens stay in the secret store.
     */
    async signIn(rawOrigin: string, provider?: string): Promise<NativeSession> {
      const origin = normalizeHermesOrigin(rawOrigin)
      if (!(await deps.confirmSignIn(origin)))
        throw new CindlError('forbidden', 'Sign-in was not confirmed.')
      const pkce = await createPkcePair(deps.crypto)
      const state = createState(deps.crypto)
      const callbackUrl = await deps.authorizer.authorize((redirectUri) =>
        buildAuthorizeUrl({
          origin,
          redirectUri,
          pkce,
          state,
          ...(provider === undefined ? {} : { provider }),
        }),
      )
      const result = parseCallback(callbackUrl, state)
      if (!result.ok) {
        if (result.reason === 'provider-error')
          throw new CindlError(
            'unauthenticated',
            'Hermes reported that sign-in did not complete.',
            result.detail === undefined ? undefined : redactText(result.detail),
          )
        throw new CindlError(
          result.reason === 'state-mismatch' ? 'unauthenticated' : 'protocol',
          'The sign-in response did not match this request. Start it again.',
        )
      }
      const tokens = await exchange(origin, result.code, pkce.verifier)
      generation += 1
      const previous = await deps.kv.get(ORIGIN_KEY)
      // Only the normalized origin is stored.
      if (previous !== undefined && previous !== origin)
        await deps.secrets.delete(tokenKey(previous))
      await writeTokens(origin, tokens)
      await deps.kv.set(ORIGIN_KEY, origin)
      deps.log?.info('Signed in to Hermes with the native flow', { origin })
      const session = toSession(origin, tokens)
      deps.onSignedIn?.(session)
      return session
    },

    /** A valid access token for main-process requests, refreshed when close to expiry. */
    async accessToken(): Promise<string> {
      const current = await signedIn()
      if (!current)
        throw new CindlError('unauthenticated', 'Not signed in to Hermes on this device.')
      if (expiresAtMs(current.tokens.expires_at) - now() > REFRESH_MARGIN_MS)
        return current.tokens.access_token
      // Single flight: concurrent callers share one refresh (the token rotates).
      refreshing ??= refreshTokens(current.origin, current.tokens).finally(() => {
        refreshing = undefined
      })
      return (await refreshing).access_token
    },

    /** Forgets this device's tokens. Hermes v0.22.5 cannot revoke them remotely. */
    async signOut(): Promise<{ localOnly: true }> {
      generation += 1
      // The raw stored value: tokens are forgotten even if the origin is no longer trusted.
      const origin = await deps.kv.get(ORIGIN_KEY)
      if (origin !== undefined) await deps.secrets.delete(tokenKey(origin))
      return { localOnly: true }
    },
  }
}

export type NativeAuth = ReturnType<typeof createNativeAuth>
