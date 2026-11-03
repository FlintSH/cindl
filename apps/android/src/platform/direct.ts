import { createDirectClient, type DirectClientDeps } from '@cindl/client-core'
import {
  CindlError,
  parseOpArgs,
  type CindlClientApi,
  type CindlEvent,
  type OpArgs,
  type OpName,
  type OpResult,
} from '@cindl/contracts'
import { NativeAuth, type DiagnosticSink } from '@cindl/hermes-adapter'
import { INTERRUPTED_NOTICE } from '../auth/loopback.ts'
import { migrateEarlierSignIn, ORIGIN_KEY, readStoredOrigin } from '../auth/migrate.ts'
import type { AndroidPlatform } from './android.ts'

export const MEMORY_ONLY_NOTICE =
  'This device cannot encrypt secrets, so after you sign in Cindl keeps the Hermes tokens in memory only and forgets them when the app closes.'

/** The real build's Hermes client and what the app does with it besides calling it. */
/** Property signatures: every member is safe to pass around unbound. */
export interface AndroidClient {
  api: CindlClientApi
  /** Loads device state and connects when signed in. Call once the UI has subscribed. */
  start: () => Promise<void>
  stop: () => void
  /** Stops waiting for the browser; the sign-in in progress then fails as cancelled. */
  cancelSignIn: () => void
}

/**
 * The real Android client: client-core's direct client on the Android
 * platform pieces, with one PKCE implementation (the adapter's NativeAuth,
 * run by the direct client, as on desktop). Around it, this keeps only what
 * the platform owns:
 *
 * - an earlier build's sign-in is moved to where NativeAuth reads it, and an
 *   interrupted one is reported, before the client starts;
 * - the origin is stored only after a sign-in succeeded, and signing in to
 *   another origin forgets the previous origin's tokens;
 * - after a failed sign-in the client starts again from what is stored, so
 *   its link says what is true (signed out, or offline) instead of
 *   "connecting".
 */
export async function createAndroidClient(
  platform: AndroidPlatform,
  options: { log?: DiagnosticSink; connection?: DirectClientDeps['connection'] } = {},
): Promise<AndroidClient> {
  const earlier = await migrateEarlierSignIn(platform)
  const interrupted = (await platform.recoverInterruptedSignIn()) || earlier.interrupted
  const direct = createDirectClient({
    ...(earlier.origin === undefined ? {} : { origin: earlier.origin }),
    auth: 'native-pkce',
    fetch: platform.fetch,
    socketFactory: platform.webSocket,
    clock: platform.clock,
    kv: platform.keyValue,
    secrets: platform.secrets,
    crypto: platform.crypto,
    authorizer: platform.authorizer,
    ...(options.log ? { log: options.log } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
  })

  // Shown to every subscriber once: the store keeps them until dismissed.
  const notices: CindlEvent[] = [
    ...(interrupted
      ? [
          {
            type: 'notice' as const,
            level: 'warning' as const,
            message: INTERRUPTED_NOTICE,
          },
        ]
      : []),
    ...(platform.secrets.available
      ? []
      : [
          {
            type: 'notice' as const,
            level: 'warning' as const,
            message: MEMORY_ONLY_NOTICE,
          },
        ]),
  ]
  const listeners = new Set<(event: CindlEvent) => void>()
  direct.subscribe((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  /** Tokens are kept per origin by NativeAuth; forget another origin's through it. */
  const forget = (origin: string) =>
    new NativeAuth({
      origin,
      fetch: platform.fetch,
      timers: platform.clock,
      secrets: platform.secrets,
      crypto: platform.crypto,
    }).signOut()

  let signingIn = false
  const signIn = async (args: OpArgs<'auth.signIn'>) => {
    const { origin } = parseOpArgs('auth.signIn', args)
    if (signingIn)
      throw new CindlError('unavailable', 'A sign-in is already waiting for the browser.')
    signingIn = true
    try {
      const previous = await readStoredOrigin(platform.keyValue)
      const link = await direct.call('auth.signIn', { origin })
      await platform.keyValue.set(ORIGIN_KEY, origin)
      if (previous !== undefined && previous !== origin) await forget(previous)
      return link
    } catch (error) {
      direct.stop()
      // start() reports its own failures through the link; this error is the one to show.
      await direct.start().catch(() => undefined)
      throw error
    } finally {
      signingIn = false
    }
  }

  const api: CindlClientApi = {
    subscribe(listener) {
      listeners.add(listener)
      for (const notice of notices) listener(notice)
      return () => listeners.delete(listener)
    },
    call: <K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>> =>
      name === 'auth.signIn'
        ? (signIn(args as OpArgs<'auth.signIn'>) as Promise<OpResult<K>>)
        : direct.call(name, args),
  }
  return {
    api,
    start: () => direct.start(),
    stop: () => direct.stop(),
    cancelSignIn: () => platform.authorizer.cancel(),
  }
}
