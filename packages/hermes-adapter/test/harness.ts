import {
  closeFakes,
  nodeSocketFactory,
  startFakeHermes,
  type FakeHermes,
  type FakeHermesOptions,
  type FakeSession,
  type NodeSocketOptions,
} from '@cindl/fixtures/fake-hermes'
import { afterEach } from 'vitest'
import {
  createDiagnostics,
  HermesConnection,
  RestClient,
  type ConnectionCallbacks,
  type ConnectionState,
  type DiagnosticEntry,
  type HermesConnectionOptions,
  type Timers,
} from '../src/index.ts'

export const timers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const running: FakeHermes[] = []

afterEach(() => closeFakes(running.splice(0)))

export async function fakeHermes(options: FakeHermesOptions = {}): Promise<FakeHermes> {
  const fake = await startFakeHermes(options)
  running.push(fake)
  return fake
}

/** A RestClient that sends a fixed bearer token (no refresh). */
export function bearerRest(fake: FakeHermes, session: FakeSession | (() => string)) {
  return new RestClient({
    origin: fake.origin,
    fetch: (url, init) => fetch(url, init),
    timers,
    auth: {
      kind: 'bearer',
      accessToken: () =>
        Promise.resolve(typeof session === 'function' ? session() : session.accessToken),
      refresh: (_failedToken: string) => Promise.resolve(false),
    },
  })
}

export function captureLog() {
  const entries: DiagnosticEntry[] = []
  return {
    entries,
    diagnostics: createDiagnostics((entry) => entries.push(entry)),
    text: () => JSON.stringify(entries),
  }
}

export interface Recorder extends ConnectionCallbacks {
  states: ConnectionState[]
  events: Array<{
    type: string
    epoch: number
    payload: unknown
    session_id?: string
    seq?: number
  }>
  waitFor(
    predicate: (state: ConnectionState) => boolean,
    ms?: number,
  ): Promise<ConnectionState>
}

export function recorder(overrides: Partial<ConnectionCallbacks> = {}): Recorder {
  const states: ConnectionState[] = []
  const events: Recorder['events'] = []
  const waiters: Array<{
    predicate: (s: ConnectionState) => boolean
    resolve: (s: ConnectionState) => void
  }> = []
  return {
    states,
    events,
    onReady: overrides.onReady ?? (() => undefined),
    onEvent:
      overrides.onEvent ??
      ((params, epoch) =>
        events.push({
          type: params.type,
          epoch,
          payload: params.payload,
          ...(params.session_id ? { session_id: params.session_id } : {}),
          ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        })),
    onServerRequest: overrides.onServerRequest ?? (() => undefined),
    ...(overrides.onUnhandledServerRequest
      ? { onUnhandledServerRequest: overrides.onUnhandledServerRequest }
      : {}),
    onState(state) {
      states.push(state)
      for (const waiter of [...waiters])
        if (waiter.predicate(state)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(state)
        }
    },
    waitFor(predicate, ms = 5_000) {
      const current = states.at(-1)
      if (current && predicate(current)) return Promise.resolve(current)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting; states: ${JSON.stringify(states.map((s) => s.phase))}`,
              ),
            ),
          ms,
        )
        waiters.push({
          predicate,
          resolve: (state) => {
            clearTimeout(timer)
            resolve(state)
          },
        })
      })
    },
  }
}

export function connection(
  fake: FakeHermes,
  rest: RestClient,
  callbacks: ConnectionCallbacks,
  options: Partial<HermesConnectionOptions> & { socket?: NodeSocketOptions } = {},
) {
  const { socket, ...rest2 } = options
  return new HermesConnection({
    origin: fake.origin,
    rest,
    socketFactory: nodeSocketFactory(socket),
    timers,
    callbacks,
    backoff: { initialMs: 20, maxMs: 100 },
    random: () => 0.5,
    ...rest2,
  })
}

export const until = async (check: () => boolean, ms = 5_000) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
