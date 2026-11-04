import { CindlError } from '@cindl/contracts'
import { silentDiagnostics, type Diagnostics } from './diagnostics.ts'
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  parseCallback,
  type CryptoProvider,
} from './pkce.ts'
import type { FetchLike, LoopbackLeg, SecretVault, Timers } from './platform.ts'
import { RestClient, type RestAuth } from './rest.ts'
import { NativeTokenResponse } from './wire.ts'

/** What the UI may know about a native sign-in. Tokens never leave this class. */
export interface NativeIdentity {
  provider: string
  userId: string
  /** Access-token expiry, Unix seconds (Hermes `expires_at`). */
  expiresAt: number
  /** False when the OS secret store is unavailable: tokens live in memory only. */
  persistent: boolean
}

export interface NativeAuthOptions {
  origin: string
  fetch: FetchLike
  timers: Timers
  secrets: SecretVault
  crypto: CryptoProvider
  diagnostics?: Diagnostics
  /** Refresh this long before the access token expires. Default 60 s. */
  refreshSkewMs?: number
}

/**
 * The secret-store key NativeAuth keeps an origin's tokens under. Platforms
 * that migrate or inspect the store use this instead of repeating the format.
 */
export function nativeTokensKey(origin: string): string {
  return `cindl.hermes.native-tokens.v1|${new URL(origin).origin}`
}

/**
 * RFC 8252 native sign-in for desktop and Android (ADR 0003), against
 * hermes_cli/dashboard_auth/routes.py at v0.22.5:
 * authorize (system browser + loopback) → `/auth/native/token` → bearer
 * tokens, rotated through `/auth/native/refresh`. Tokens are stored only in
 * the injected OS-backed `SecretVault`; when it is unavailable they stay in
 * memory and `persistent` is false. Sign-out is local: Hermes v0.22.5 has no
 * native token revocation.
 */
export class NativeAuth {
  readonly #options: NativeAuthOptions
  readonly #public: RestClient
  readonly #key: string
  readonly #log: Diagnostics
  #tokens: NativeTokenResponse | undefined
  #loading: Promise<void> | undefined
  #refreshing: Promise<boolean> | undefined
  /** Bumped by sign-out and retirement: results of work started before are discarded. */
  #generation = 0

  constructor(options: NativeAuthOptions) {
    this.#options = options
    this.#log = options.diagnostics ?? silentDiagnostics
    const origin = new URL(options.origin).origin
    this.#key = nativeTokensKey(origin)
    this.#public = new RestClient({
      origin,
      fetch: options.fetch,
      timers: options.timers,
      auth: { kind: 'none' },
      diagnostics: this.#log,
    })
  }

  get persistent(): boolean {
    return this.#options.secrets.available
  }

  /** REST auth that sends the access token and refreshes once on a 401. */
  restAuth(): RestAuth {
    return {
      kind: 'bearer',
      accessToken: () => this.accessToken(),
      refresh: (failedToken) => this.refresh(failedToken),
    }
  }

  /** The signed-in identity, loading stored tokens on first use. */
  async identity(): Promise<NativeIdentity | undefined> {
    const tokens = await this.#current()
    return tokens && this.#identityOf(tokens)
  }

  async signIn(leg: LoopbackLeg, provider?: string): Promise<NativeIdentity> {
    const generation = this.#generation
    const pkce = await createPkcePair(this.#options.crypto)
    const state = createState(this.#options.crypto)
    const callbackUrl = await leg.authorize((redirectUri) =>
      buildAuthorizeUrl({
        origin: this.#options.origin,
        redirectUri,
        pkce,
        state,
        ...(provider ? { provider } : {}),
      }),
    )
    const callback = parseCallback(callbackUrl, state)
    if (!callback.ok) {
      this.#log.log('warn', 'auth.callback-rejected', { reason: callback.reason })
      throw new CindlError(
        'unauthenticated',
        callback.reason === 'provider-error'
          ? 'Hermes sign-in was cancelled or failed.'
          : 'Hermes sign-in did not complete. Try again.',
        `native callback: ${callback.reason}`,
      )
    }
    let tokens: NativeTokenResponse
    try {
      tokens = await this.#public.nativeToken(callback.code, pkce.verifier)
    } catch (error) {
      if (error instanceof CindlError && error.code === 'invalid')
        throw new CindlError(
          'unauthenticated',
          'The Hermes sign-in code expired or was already used. Sign in again.',
          error.detail,
        )
      throw error
    }
    if (generation !== this.#generation)
      throw new CindlError('unauthenticated', 'Signed out while signing in.')
    await this.#store(tokens)
    this.#log.log('info', 'auth.signed-in', { provider: tokens.provider })
    return this.#identityOf(tokens)
  }

  /** A usable access token, refreshing it first when it is about to expire. */
  async accessToken(): Promise<string | undefined> {
    const tokens = await this.#current()
    if (!tokens) return undefined
    const skew = this.#options.refreshSkewMs ?? 60_000
    if (tokens.expires_at * 1000 - skew <= this.#options.timers.now()) {
      try {
        await this.refresh()
      } catch {
        // Hermes or its provider is unreachable: keep the current token; a 401
        // later triggers one more refresh attempt.
      }
    }
    return this.#tokens?.access_token
  }

  /**
   * Rotate the token pair. Concurrent callers share one request so a rotated
   * refresh token is never replayed, and a caller whose `failedToken` was
   * already replaced just retries. Resolves false (and forgets the tokens)
   * when Hermes answers 401 `session_expired`; throws on 503 and keeps them.
   */
  async refresh(failedToken?: string): Promise<boolean> {
    if (this.#refreshing) return this.#refreshing
    const current = await this.#current()
    if (failedToken !== undefined && current && current.access_token !== failedToken)
      return true
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  /**
   * Local sign-out: forget tokens on this device. Hermes cannot revoke them
   * remotely. The stored record is always deleted, whatever `available` says:
   * a store that can no longer encrypt may still delete, and a record left
   * behind would sign this origin back in after a restart. If the delete
   * itself fails, the tokens are still gone from memory and the failure is
   * logged.
   */
  async signOut(): Promise<void> {
    this.#generation++
    this.#tokens = undefined
    this.#loading = Promise.resolve()
    try {
      await this.#options.secrets.delete(this.#key)
    } catch {
      this.#log.log('warn', 'auth.stored-tokens-not-deleted')
    }
  }

  /**
   * This origin's sign-in has been left for another: the client switched
   * away. Work still in flight (a refresh, a load, a sign-in) can no longer
   * store, return or delete tokens, and nothing later can use any: the
   * stored record now belongs to whoever deletes it or signs this origin in
   * again, under the same key or not. Unlike `signOut` it never touches the
   * store itself.
   */
  retire(): void {
    this.#generation++
    this.#tokens = undefined
    this.#loading = Promise.resolve()
  }

  async #doRefresh(): Promise<boolean> {
    const tokens = await this.#current()
    if (!tokens) return false
    const generation = this.#generation
    try {
      const next = await this.#public.nativeRefresh(tokens.refresh_token, tokens.provider)
      // A sign-out or retirement while the refresh was in flight wins: never
      // write the rotated pair back.
      if (generation !== this.#generation) return false
      await this.#store(next)
      this.#log.log('info', 'auth.refreshed', { provider: next.provider })
      return true
    } catch (error) {
      // Signed out or retired meanwhile: the stored record is not this
      // refresh's any more, so a late refusal must not delete it.
      if (generation !== this.#generation) return false
      if (error instanceof CindlError && error.code === 'unauthenticated') {
        this.#log.log('info', 'auth.refresh-rejected')
        await this.signOut()
        return false
      }
      throw error
    }
  }

  async #current(): Promise<NativeTokenResponse | undefined> {
    // One shared load: concurrent first callers all see the stored tokens. A
    // load that failed is not kept, so the next caller reads the store again.
    this.#loading ??= this.#load().catch((error: unknown) => {
      this.#loading = undefined
      throw error
    })
    await this.#loading
    return this.#tokens
  }

  async #load(): Promise<void> {
    if (!this.#options.secrets.available) return
    const generation = this.#generation
    let raw: string | undefined
    try {
      raw = await this.#options.secrets.get(this.#key)
    } catch (error) {
      // A failure on this device, not Hermes's answer: say so.
      this.#log.log('warn', 'auth.secret-store-read-failed', {
        error: error instanceof Error ? error.name : 'unknown',
      })
      throw new CindlError(
        'internal',
        'This device could not read its saved Hermes sign-in.',
        'secret store read failed',
      )
    }
    if (!raw || generation !== this.#generation) return
    try {
      const parsed = NativeTokenResponse.safeParse(JSON.parse(raw))
      if (parsed.success) this.#tokens = parsed.data
    } catch {
      this.#log.log('warn', 'auth.stored-tokens-unreadable')
    }
  }

  async #store(tokens: NativeTokenResponse): Promise<void> {
    this.#tokens = tokens
    this.#loading = Promise.resolve()
    if (this.#options.secrets.available)
      await this.#options.secrets.set(this.#key, JSON.stringify(tokens))
  }

  #identityOf(tokens: NativeTokenResponse): NativeIdentity {
    return {
      provider: tokens.provider,
      userId: tokens.user_id,
      expiresAt: tokens.expires_at,
      persistent: this.persistent,
    }
  }
}
