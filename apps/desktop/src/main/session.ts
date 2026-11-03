/**
 * The real desktop app's Hermes client: client-core's direct client on the
 * Electron platform pieces (platform/index.ts), with the protections only
 * main can add around it:
 *
 * - sign-in starts only after the owner confirms the origin in a native
 *   dialog, before anything is sent to it or the browser opens;
 * - requests and sockets reach only that confirmed origin (pinned fetch and
 *   WebSocket factory);
 * - the origin is stored only after a sign-in succeeded, and signing in
 *   elsewhere forgets the previous origin's tokens.
 *
 * PKCE, token refresh and sign-out are the adapter's NativeAuth, through the
 * direct client: one implementation for every native platform.
 */
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
import type { Logger } from './log.ts'
import { memoryOnlyNotice, ORIGIN_KEY, type DesktopPlatform } from './platform/index.ts'

export interface RealClient {
  client: CindlClientApi
  /** Events every new subscriber receives after the snapshot. */
  notices: () => CindlEvent[]
  /** Load device state and connect when signed in (after subscribers are attached). */
  start(): Promise<void>
  stop(): void
}

/** Adapter diagnostics (already redacted) into the main-process log. */
export function diagnosticSink(log: Logger): DiagnosticSink {
  return (entry) => log[entry.level](`hermes ${entry.event}`, entry.detail)
}

export function createRealClient(
  platform: DesktopPlatform,
  options: {
    /** The native "Sign in to <origin>?" dialog. */
    confirmSignIn(origin: string): Promise<boolean>
    log: Logger
    connection?: DirectClientDeps['connection']
  },
): RealClient {
  const origin = platform.origin()
  const direct = createDirectClient({
    ...(origin === undefined ? {} : { origin }),
    auth: 'native-pkce',
    fetch: platform.fetch,
    socketFactory: platform.webSocket,
    clock: platform.clock,
    kv: platform.kv,
    secrets: platform.secrets,
    crypto: platform.crypto,
    authorizer: platform.authorizer,
    log: diagnosticSink(options.log),
    ...(options.connection ? { connection: options.connection } : {}),
  })

  let confirming = false
  const signIn = async (args: OpArgs<'auth.signIn'>) => {
    // Already parsed at the IPC boundary; parsed again so this holds on its own.
    const { origin: target } = parseOpArgs('auth.signIn', args)
    if (confirming)
      throw new CindlError(
        'unavailable',
        'A sign-in is already waiting for your confirmation.',
      )
    confirming = true
    let confirmed: boolean
    try {
      confirmed = await options.confirmSignIn(target)
    } finally {
      confirming = false
    }
    if (!confirmed)
      throw new CindlError('forbidden', 'Sign-in was not confirmed. Nothing was sent.')
    const previous = platform.origin()
    platform.pinOrigin(target)
    const link = await direct.call('auth.signIn', { origin: target })
    await platform.kv.set(ORIGIN_KEY, target)
    if (previous !== undefined && previous !== target)
      // Tokens are kept per origin by the adapter; forget the old ones through it.
      await new NativeAuth({
        origin: previous,
        fetch: platform.fetch,
        timers: platform.clock,
        secrets: platform.secrets,
        crypto: platform.crypto,
      }).signOut()
    return link
  }

  const listeners = new Set<(event: CindlEvent) => void>()
  const emit = (event: CindlEvent) => {
    for (const listener of [...listeners]) listener(event)
  }
  direct.subscribe(emit)

  const client: CindlClientApi = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    call: <K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>> =>
      name === 'auth.signIn'
        ? (signIn(args as OpArgs<'auth.signIn'>) as Promise<OpResult<K>>)
        : direct.call(name, args),
  }

  return {
    client,
    notices: () =>
      platform.secrets.persistence === 'memory-only'
        ? [memoryOnlyNotice(platform.secrets.reason)]
        : [],
    start: () => direct.start(),
    stop: () => direct.stop(),
  }
}
