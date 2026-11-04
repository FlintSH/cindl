import type { KeyValueStore, LoopbackAuthorizer } from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'
import { canonicalLoopbackRedirect } from '@cindl/hermes-adapter'
import type { CindlLoopbackNative } from '../../modules/cindl-loopback/index.ts'

/**
 * The browser leg of Hermes native sign-in on Android (RFC 8252, ADR 0003).
 * PKCE, the code exchange and the tokens belong to the adapter's NativeAuth,
 * which the direct client runs; this module only opens the authorize page
 * and hands back the callback:
 *
 * 1. A Kotlin listener binds 127.0.0.1 on an ephemeral port (the only
 *    redirect form Hermes v0.22.5 accepts; no custom schemes, App Links or
 *    `localhost`).
 * 2. The authorize URL NativeAuth builds opens in a Custom Tab, and the
 *    listener accepts only a callback carrying that URL's `state`.
 * 3. The callback's address goes back to NativeAuth, which exchanges the code.
 *
 * While the browser is open, a marker of the attempt (an id and a time; no
 * verifier, state or code) is kept in the key-value store. If Android ends
 * the app meanwhile, the listener and the verifier end with it, and the next
 * start finds the marker and says the sign-in was interrupted.
 */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
export const ATTEMPT_MARKER_KEY = 'signin.attempt.v2'

export const INTERRUPTED_NOTICE =
  'Cindl stopped waiting for the browser (the app was closed during sign-in). Nothing was saved. Start again.'

export const redirectUriFor = (port: number) =>
  canonicalLoopbackRedirect(`http://127.0.0.1:${port}/callback`)

export interface LoopbackDeps {
  loopback: CindlLoopbackNative
  /** Opens the system browser (a Custom Tab in Cindl's task). */
  openBrowser: (url: string) => Promise<void>
  keyValue: KeyValueStore
  now: () => number
  newAttemptId: () => string
}

export interface AndroidLoopbackAuthorizer extends LoopbackAuthorizer {
  /**
   * Stops the attempt under way: its browser does not open if it has not yet,
   * and its sign-in fails with "Sign-in was cancelled".
   */
  cancel(): void
}

interface Marker {
  v: 2
  id: string
  startedAt: number
}

function parseMarker(raw: string): Marker | undefined {
  try {
    const value = JSON.parse(raw) as Partial<Marker>
    return value.v === 2 &&
      typeof value.id === 'string' &&
      typeof value.startedAt === 'number'
      ? (value as Marker)
      : undefined
  } catch {
    return undefined
  }
}

/** Removes this attempt's marker only, best effort: the next start clears one left behind. */
async function forgetMarker(deps: Pick<LoopbackDeps, 'keyValue'>, id: string) {
  try {
    const raw = await deps.keyValue.get(ATTEMPT_MARKER_KEY)
    if (raw !== undefined && parseMarker(raw)?.id === id)
      await deps.keyValue.delete(ATTEMPT_MARKER_KEY)
  } catch {
    // Reported as interrupted on the next start, which is still true: nothing was saved.
  }
}

const cancelled = () =>
  new CindlError('unauthenticated', 'Sign-in was cancelled. Nothing was saved.')

/** client-core's LoopbackAuthorizer on the Kotlin listener, one attempt at a time. */
export function createLoopbackAuthorizer(deps: LoopbackDeps): AndroidLoopbackAuthorizer {
  let current: string | undefined
  return {
    async authorize(buildUrl) {
      const id = deps.newAttemptId()
      // A new attempt ends the wait of an earlier one.
      if (current !== undefined) deps.loopback.cancel(current)
      current = id
      // After each wait before the browser opens: a cancel() or a newer attempt
      // may have come meanwhile, which the listener can have missed (Kotlin
      // drops a cancel for an attempt it has not started yet), so no browser
      // opens. The finally stops the listener and removes the marker.
      const stillWanted = () => {
        if (current !== id) throw cancelled()
      }
      try {
        const { port } = await deps.loopback.start(id, SIGN_IN_TIMEOUT_MS)
        stillWanted()
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
        await deps.keyValue.set(
          ATTEMPT_MARKER_KEY,
          JSON.stringify({ v: 2, id, startedAt: deps.now() } satisfies Marker),
        )
        stillWanted()
        await deps.openBrowser(url)
        try {
          return `http://127.0.0.1:${port}${await deps.loopback.awaitCallback(id)}`
        } catch (error) {
          throw listenerError(error)
        }
      } finally {
        deps.loopback.cancel(id)
        if (current === id) current = undefined
        await forgetMarker(deps, id)
      }
    },
    cancel() {
      if (current !== undefined) deps.loopback.cancel(current)
      // The attempt sees it at its next step, even with its listener not started yet.
      current = undefined
    },
  }
}

/**
 * On start: true when an attempt from an earlier run never finished (the app
 * was closed, or only its JavaScript restarted, while the browser was open).
 * Its listener is stopped and its marker removed; nothing of it was saved.
 */
export async function recoverInterruptedSignIn(
  deps: Pick<LoopbackDeps, 'keyValue' | 'loopback'>,
): Promise<boolean> {
  const raw = await deps.keyValue.get(ATTEMPT_MARKER_KEY)
  if (raw === undefined) return false
  const marker = parseMarker(raw)
  if (marker) deps.loopback.cancel(marker.id)
  await deps.keyValue.delete(ATTEMPT_MARKER_KEY)
  return true
}

function listenerError(error: unknown): CindlError {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ERR_LOOPBACK_TIMEOUT')
    return new CindlError(
      'timeout',
      'The browser did not return to Cindl in time. Nothing was saved.',
    )
  if (code === 'ERR_LOOPBACK_CANCELLED') return cancelled()
  return new CindlError(
    'internal',
    'Cindl stopped waiting for the browser (the app may have been closed). Start again.',
  )
}
