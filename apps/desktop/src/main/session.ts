/**
 * The real desktop app's Hermes client: client-core's direct client on the
 * Electron platform pieces (platform/index.ts), with the protections only
 * main can add around it:
 *
 * - sign-in starts only after the owner confirms the origin in a native
 *   dialog, before anything is sent to it or the browser opens;
 * - requests and sockets reach only the pinned origin (pinned fetch and
 *   WebSocket factories);
 * - signing in elsewhere is all or nothing. The new origin is stored, and the
 *   previous origin's tokens forgotten, only after the sign-in succeeded. A
 *   failed or cancelled one puts the pin back and, unless the client kept its
 *   session, restarts the client on the previous origin, whose stored origin
 *   and tokens it never touched;
 * - one sign-in at a time: a newer one, or a sign-out, cancels the browser
 *   wait of the one in flight and lets it settle first.
 *
 * PKCE, token refresh and sign-out are the adapter's NativeAuth, through the
 * direct client: one implementation for every native platform. So is the live
 * screen: the direct client speaks RFB over main's screen socket, and the
 * renderer only receives `display.frame` results (pixels), never the ticket.
 */
import {
  createDirectClient,
  type DirectClient,
  type DirectClientDeps,
  type LoopbackAuthorizer,
} from '@cindl/client-core'
import {
  CindlError,
  parseOpArgs,
  type CindlClientApi,
  type CindlEvent,
  type LinkState,
  type OpArgs,
  type OpName,
  type OpResult,
} from '@cindl/contracts'
import { nativeTokensKey, redactText, type DiagnosticSink } from '@cindl/hermes-adapter'
import type { Logger } from './log.ts'
import {
  keyringRefusedNotice,
  memoryOnlyNotice,
  ORIGIN_KEY,
  type DesktopPlatform,
} from './platform/index.ts'
import { trustedStoredOrigin } from './platform/origin-policy.ts'

/**
 * Settings key: origins this device left whose tokens could not be removed
 * yet. Each is retried at the next start and after the next switch.
 */
export const FORGET_KEY = 'hermes.forget'

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

const replaced = () =>
  new CindlError('unavailable', 'A newer sign-in or a sign-out replaced this sign-in.')

export function createRealClient(
  platform: DesktopPlatform,
  options: {
    /** The native "Sign in to <origin>?" dialog. */
    confirmSignIn(origin: string): Promise<boolean>
    log: Logger
    connection?: DirectClientDeps['connection']
  },
): RealClient {
  const { log } = options
  /** The origin of the last sign-in that succeeded (the stored one at start). */
  let committed = platform.origin()
  let stopped = false
  let degraded = false
  let confirming = false
  /** Bumped by every confirmed sign-in and every sign-out. */
  let generation = 0
  /** The generation whose sign-in may open the browser now. */
  let running = 0
  /** Settles when the sign-in or sign-out in progress has finished. */
  let turn: Promise<void> = Promise.resolve()

  // The browser leg, for the latest sign-in only: one that a newer sign-in
  // replaced never opens the browser.
  const authorizer: LoopbackAuthorizer = {
    authorize: (buildUrl) =>
      running === generation
        ? platform.authorizer.authorize(buildUrl)
        : Promise.reject(replaced()),
  }

  const makeDirect = (origin: string | undefined): DirectClient =>
    createDirectClient({
      ...(origin === undefined ? {} : { origin }),
      auth: 'native-pkce',
      fetch: platform.fetch,
      socketFactory: platform.webSocket,
      displaySocketFactory: platform.displaySocket,
      clock: platform.clock,
      kv: platform.kv,
      secrets: platform.secrets,
      crypto: platform.crypto,
      authorizer,
      log: diagnosticSink(log),
      ...(options.connection ? { connection: options.connection } : {}),
    })

  const listeners = new Set<(event: CindlEvent) => void>()
  const emit = (event: CindlEvent) => {
    for (const listener of [...listeners]) listener(event)
  }
  let direct = makeDirect(committed)
  let detach = direct.subscribe(emit)

  platform.secrets.onDegrade(() => {
    degraded = true
    emit(keyringRefusedNotice(platform.secrets.reason))
  })

  /** A fresh client on `origin` (none: Not set up), as a restart would make it. */
  const restartOn = async (origin: string | undefined) => {
    detach()
    direct.stop()
    direct = makeDirect(origin)
    detach = direct.subscribe(emit)
    if (!stopped) await direct.start()
  }

  /**
   * After a failed or cancelled sign-in: the pin goes back to `previous`. The
   * client restarts there unless it kept its session (a client that switches
   * only on success); the stored origin and tokens were never changed.
   */
  const recover = async (previous: string | undefined) => {
    platform.pinOrigin(previous)
    if (stopped) return
    const link = await direct.call('link.get', {})
    const kept =
      previous === undefined
        ? link.phase === 'unconfigured'
        : link.phase === 'online' && link.server?.origin === previous
    if (!kept) await restartOn(previous)
  }

  const readForget = async (): Promise<string[]> => {
    try {
      const parsed: unknown = JSON.parse((await platform.kv.get(FORGET_KEY)) ?? '[]')
      return Array.isArray(parsed)
        ? parsed.filter(
            (origin): origin is string =>
              typeof origin === 'string' && trustedStoredOrigin(origin) === origin,
          )
        : []
    } catch {
      return []
    }
  }
  const writeForget = (origins: readonly string[]) =>
    origins.length
      ? platform.kv.set(FORGET_KEY, JSON.stringify(origins))
      : platform.kv.delete(FORGET_KEY)

  /** Removes the tokens of the origins this device left; returns those that failed. */
  const forget = async (): Promise<string[]> => {
    const left: string[] = []
    for (const origin of await readForget()) {
      if (origin === committed) continue
      try {
        // Delete the stored record directly: the adapter's sign-out logs a
        // failed delete instead of throwing, and this must know, to warn and
        // try again at the next start.
        await platform.secrets.delete(nativeTokensKey(origin))
      } catch (error) {
        log.warn('Could not remove the tokens of a previous Hermes yet', error)
        left.push(origin)
      }
    }
    await writeForget(left)
    return left
  }

  const report = (target: string, previous: string | undefined, error: unknown) => {
    const reason =
      error instanceof CindlError ? error.message : 'Sign-in did not complete.'
    const stayed =
      previous !== undefined && previous !== target
        ? ` Cindl is still on ${previous}.`
        : ''
    emit({
      type: 'notice',
      level: 'warning',
      message: redactText(`Sign-in to ${target} did not complete. ${reason}${stayed}`),
    })
  }

  /**
   * Runs `work` once every earlier sign-in or sign-out has settled. Starting
   * one cancels the browser wait of the sign-in in flight; a sign-in that a
   * newer one replaced before its turn does not run at all.
   */
  const inTurn = async <T>(
    work: (mine: number) => Promise<T>,
    replaceable: boolean,
  ): Promise<T> => {
    const mine = ++generation
    platform.authorizer.cancel()
    const before = turn
    let done: () => void = () => undefined
    turn = new Promise<void>((resolve) => (done = resolve))
    try {
      await before
      if (replaceable && mine !== generation) throw replaced()
      running = mine
      return await work(mine)
    } finally {
      done()
    }
  }

  const attempt = async (target: string, mine: number): Promise<LinkState> => {
    const previous = committed
    platform.pinOrigin(target)
    let link: LinkState
    try {
      link = await direct.call('auth.signIn', { origin: target })
    } catch (error) {
      await recover(previous).catch((cause: unknown) =>
        log.error('Could not return to the previous Hermes', cause),
      )
      // A sign-in a newer one replaced is not news.
      if (mine === generation) report(target, previous, error)
      throw error
    }
    if (target === previous) return link
    try {
      // Listed before the switch is stored, so even a crash in between
      // cannot leave the previous origin's tokens behind.
      if (previous !== undefined) {
        const pending = new Set(await readForget())
        pending.add(previous)
        pending.delete(target)
        await writeForget([...pending])
      }
      await platform.kv.set(ORIGIN_KEY, target)
    } catch (error) {
      // Signed in, but a restart would not come back here: undo the switch.
      log.error(
        'Could not store the new Hermes origin; staying on the previous one',
        error,
      )
      await direct.call('auth.signOut', {}).catch(() => undefined)
      await recover(previous).catch((cause: unknown) =>
        log.error('Could not return to the previous Hermes', cause),
      )
      const failure = new CindlError(
        'internal',
        'Cindl could not save the new Hermes address, so it did not switch.',
      )
      report(target, previous, failure)
      throw failure
    }
    committed = target
    let left: string[]
    try {
      left = await forget()
    } catch (error) {
      log.warn('Could not remove the tokens of a previous Hermes yet', error)
      left = previous === undefined ? [] : [previous]
    }
    if (previous !== undefined && left.includes(previous))
      emit({
        type: 'notice',
        level: 'warning',
        message: `Signed in to ${target}, but Cindl could not remove the tokens of ${previous} from this device yet. It tries again when it next starts.`,
      })
    return link
  }

  const signIn = async (args: OpArgs<'auth.signIn'>): Promise<LinkState> => {
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
    return inTurn((mine) => attempt(target, mine), true)
  }

  // A sign-out is never skipped: it waits for (and cancels) a sign-in in flight.
  const signOut = () => inTurn(() => direct.call('auth.signOut', {}), false)

  const client: CindlClientApi = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    call: <K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>> =>
      name === 'auth.signIn'
        ? (signIn(args as OpArgs<'auth.signIn'>) as Promise<OpResult<K>>)
        : name === 'auth.signOut'
          ? (signOut() as Promise<OpResult<K>>)
          : direct.call(name, args),
  }

  return {
    client,
    notices: () =>
      platform.secrets.persistence === 'memory-only'
        ? [
            degraded
              ? keyringRefusedNotice(platform.secrets.reason)
              : memoryOnlyNotice(platform.secrets.reason),
          ]
        : [],
    start: async () => {
      stopped = false
      await forget().catch((error: unknown) =>
        log.warn('Could not remove the tokens of a previous Hermes yet', error),
      )
      await direct.start()
    },
    stop: () => {
      stopped = true
      platform.authorizer.cancel()
      direct.stop()
    },
  }
}
