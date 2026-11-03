import type { LoopbackAuthorizer, SecretStore } from '@cindl/client-core'
import { CindlError, HermesOrigin } from '@cindl/contracts'
import {
  buildAuthorizeUrl,
  canonicalLoopbackRedirect,
  createPkcePair,
  createState,
  isNativeTokenSet,
  parseCallback,
  redactText,
  restEndpoints,
  type CryptoProvider,
  type NativeTokenSet,
} from '@cindl/hermes-adapter'
import type { CindlLoopbackNative } from '../../modules/cindl-loopback/index.ts'

/**
 * Hermes native sign-in on Android (RFC 8252, ADR 0003):
 *
 * 1. A Kotlin listener binds 127.0.0.1 on an ephemeral port (the only
 *    redirect form Hermes v0.22.5 accepts; no custom schemes, App Links or
 *    `localhost`).
 * 2. The PKCE verifier and state are written to the SecretStore for this
 *    attempt, then the authorize URL opens in the system browser (Custom Tab).
 * 3. The listener accepts the one callback whose `state` matches; the app
 *    exchanges the code with `POST /auth/native/token`.
 *
 * If Android kills the app while the browser is open, the listener dies with
 * it. On the next start `recoverSignIn` finds the persisted attempt, sees no
 * listener for it in this process, wipes the verifier and reports the
 * attempt as interrupted. If the process survived (only the JavaScript
 * runtime restarted) the attempt resumes. Not yet validated on a device.
 */

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
export const ATTEMPT_KEY = 'signin.attempt'

export interface SignInAttempt {
  v: 1
  id: string
  origin: string
  provider?: string
  verifier: string
  state: string
  port: number
  startedAt: number
}

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface SignInDeps {
  crypto: CryptoProvider
  secrets: SecretStore
  loopback: CindlLoopbackNative
  /** Opens the system browser (a Custom Tab in Cindl's task). */
  openBrowser: (url: string) => Promise<void>
  fetch: FetchLike
  now: () => number
  newAttemptId: () => string
}

/** Validates an owner-entered address with the contract's rules and returns the bare origin. */
export function parseOrigin(raw: string): string {
  const result = HermesOrigin.safeParse(raw)
  if (result.success) return result.data
  throw new CindlError(
    'invalid',
    result.error.issues[0]?.message ?? 'That is not a Hermes address Cindl can use.',
  )
}

export async function signIn(
  rawOrigin: string,
  deps: SignInDeps,
  options: { provider?: string } = {},
): Promise<{ origin: string; tokens: NativeTokenSet }> {
  const origin = parseOrigin(rawOrigin)
  if (!deps.secrets.available)
    throw new CindlError(
      'unavailable',
      'This device cannot encrypt secrets, so Cindl cannot keep a sign-in.',
    )
  const id = deps.newAttemptId()
  const pkce = await createPkcePair(deps.crypto)
  const state = createState(deps.crypto)
  const { port } = await deps.loopback.start(id, SIGN_IN_TIMEOUT_MS)
  const attempt: SignInAttempt = {
    v: 1,
    id,
    origin,
    ...(options.provider ? { provider: options.provider } : {}),
    verifier: pkce.verifier,
    state,
    port,
    startedAt: deps.now(),
  }
  try {
    await deps.secrets.set(ATTEMPT_KEY, JSON.stringify(attempt))
    if (!deps.loopback.arm(id, state))
      throw new CindlError(
        'internal',
        'The sign-in listener stopped before the browser opened.',
      )
    await deps.openBrowser(
      buildAuthorizeUrl({
        origin,
        redirectUri: redirectUriFor(port),
        pkce,
        state,
        ...(options.provider ? { provider: options.provider } : {}),
      }),
    )
  } catch (error) {
    await abandon(attempt, deps)
    throw error
  }
  return { origin, tokens: await finishSignIn(attempt, deps) }
}

export const redirectUriFor = (port: number) =>
  canonicalLoopbackRedirect(`http://127.0.0.1:${port}/callback`)

export type Recovery =
  | { kind: 'none' }
  | { kind: 'resumable'; attempt: SignInAttempt }
  | { kind: 'interrupted'; origin: string | undefined }

/** On start: resume an attempt whose listener survived, or report and wipe an interrupted one. */
export async function recoverSignIn(
  deps: Pick<SignInDeps, 'secrets' | 'loopback' | 'now'>,
): Promise<Recovery> {
  const raw = await deps.secrets.get(ATTEMPT_KEY)
  if (raw === undefined) return { kind: 'none' }
  const attempt = parseAttempt(raw)
  if (attempt) {
    const status = deps.loopback.status(attempt.id)
    const fresh = deps.now() - attempt.startedAt < SIGN_IN_TIMEOUT_MS
    if (fresh && (status === 'listening' || status === 'received'))
      return { kind: 'resumable', attempt }
    deps.loopback.cancel(attempt.id)
  }
  await deps.secrets.delete(ATTEMPT_KEY)
  return { kind: 'interrupted', origin: attempt?.origin }
}

/** Waits for the callback of a started (or resumed) attempt and exchanges its code. */
export async function finishSignIn(
  attempt: SignInAttempt,
  deps: Pick<SignInDeps, 'secrets' | 'loopback' | 'fetch'>,
): Promise<NativeTokenSet> {
  try {
    let target: string
    try {
      target = await deps.loopback.awaitCallback(attempt.id)
    } catch (error) {
      throw listenerError(error)
    }
    const callback = parseCallback(
      `http://127.0.0.1:${attempt.port}${target}`,
      attempt.state,
    )
    if (!callback.ok)
      throw callback.reason === 'provider-error'
        ? new CindlError(
            'unauthenticated',
            'Hermes did not complete the sign-in. Nothing was saved.',
            callback.detail === undefined ? undefined : redactText(callback.detail),
          )
        : new CindlError(
            'protocol',
            'The sign-in callback was incomplete. Nothing was saved.',
          )
    return await exchangeCode(attempt.origin, callback.code, attempt.verifier, deps.fetch)
  } finally {
    await abandon(attempt, deps)
  }
}

/**
 * Ends an attempt: stops its listener and forgets its verifier. Removing the
 * record is best effort and only touches this attempt's own record, so a
 * storage error can never discard tokens that were just issued, and a newer
 * attempt keeps its recovery data. A record left behind is cleared by
 * `recoverSignIn` on the next start.
 */
async function abandon(
  attempt: SignInAttempt,
  deps: Pick<SignInDeps, 'secrets' | 'loopback'>,
): Promise<void> {
  deps.loopback.cancel(attempt.id)
  try {
    const stored = await deps.secrets.get(ATTEMPT_KEY)
    if (stored !== undefined && parseAttempt(stored)?.id === attempt.id)
      await deps.secrets.delete(ATTEMPT_KEY)
  } catch {
    // See above: recoverSignIn retries the cleanup.
  }
}

function parseAttempt(raw: string): SignInAttempt | undefined {
  try {
    const value = JSON.parse(raw) as Partial<SignInAttempt>
    if (
      value.v === 1 &&
      typeof value.id === 'string' &&
      typeof value.origin === 'string' &&
      typeof value.verifier === 'string' &&
      typeof value.state === 'string' &&
      typeof value.port === 'number' &&
      typeof value.startedAt === 'number'
    )
      return value as SignInAttempt
  } catch {
    // Corrupt attempts are wiped by the caller.
  }
  return undefined
}

function listenerError(error: unknown): CindlError {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ERR_LOOPBACK_TIMEOUT')
    return new CindlError(
      'timeout',
      'The browser did not return to Cindl in time. Nothing was saved.',
    )
  if (code === 'ERR_LOOPBACK_CANCELLED')
    return new CindlError('unauthenticated', 'Sign-in was cancelled. Nothing was saved.')
  return new CindlError(
    'internal',
    'Cindl stopped waiting for the browser (the app may have been closed). Start again.',
  )
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

async function postJson(
  fetch: FetchLike,
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
  } catch {
    throw new CindlError(
      'offline',
      'Cindl could not reach Hermes. Check the address and your connection.',
    )
  }
}

async function readTokenSet(response: {
  json(): Promise<unknown>
}): Promise<NativeTokenSet> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!isNativeTokenSet(body))
    throw new CindlError('protocol', 'Hermes returned an unexpected sign-in response.')
  return body
}

/** `POST /auth/native/token {code, code_verifier}`. The code is single use. */
export async function exchangeCode(
  origin: string,
  code: string,
  verifier: string,
  fetch: FetchLike,
): Promise<NativeTokenSet> {
  const response = await postJson(
    fetch,
    new URL(restEndpoints.nativeToken.path, origin).href,
    {
      code,
      code_verifier: verifier,
    },
  )
  if (response.ok) return readTokenSet(response)
  if (response.status === 429)
    throw new CindlError(
      'unavailable',
      'Hermes is limiting sign-in attempts. Wait a moment, then start again.',
    )
  if (response.status >= 500)
    throw new CindlError(
      'unavailable',
      'Hermes could not finish the sign-in. Try again later.',
    )
  throw new CindlError('unauthenticated', 'Hermes rejected the sign-in. Start again.')
}

/** `POST /auth/native/refresh {refresh_token, provider}`: a rotated token set. */
export async function refreshTokens(
  origin: string,
  tokens: Pick<NativeTokenSet, 'refresh_token' | 'provider'>,
  fetch: FetchLike,
): Promise<NativeTokenSet> {
  const response = await postJson(
    fetch,
    new URL(restEndpoints.nativeRefresh.path, origin).href,
    {
      refresh_token: tokens.refresh_token,
      provider: tokens.provider,
    },
  )
  if (response.ok) return readTokenSet(response)
  if (response.status === 401 || response.status === 400 || response.status === 403)
    throw new CindlError('unauthenticated', 'Your Hermes sign-in expired. Sign in again.')
  throw new CindlError(
    'unavailable',
    'Hermes could not refresh the sign-in. Try again later.',
  )
}

/**
 * client-core's LoopbackAuthorizer on the same listener, for a direct client
 * that runs PKCE itself. The `state` is read from the URL it builds, so only
 * a callback for that exact attempt is accepted.
 */
export function createLoopbackAuthorizer(
  deps: Pick<SignInDeps, 'loopback' | 'openBrowser' | 'newAttemptId'>,
): LoopbackAuthorizer {
  return {
    async authorize(buildUrl) {
      const id = deps.newAttemptId()
      const { port } = await deps.loopback.start(id, SIGN_IN_TIMEOUT_MS)
      try {
        const url = buildUrl(redirectUriFor(port))
        const state = new URL(url).searchParams.get('state')
        if (!state)
          throw new CindlError(
            'invalid',
            'The sign-in address has no state; Cindl will not wait for an unverifiable callback.',
          )
        if (!deps.loopback.arm(id, state))
          throw new CindlError(
            'internal',
            'The sign-in listener stopped before the browser opened.',
          )
        await deps.openBrowser(url)
        try {
          return `http://127.0.0.1:${port}${await deps.loopback.awaitCallback(id)}`
        } catch (error) {
          throw listenerError(error)
        }
      } finally {
        deps.loopback.cancel(id)
      }
    },
  }
}
