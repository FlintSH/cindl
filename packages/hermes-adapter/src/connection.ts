import { CindlError, type AuthorityMode } from '@cindl/contracts'
import type { z } from 'zod'
import { GATEWAY_SUBPROTOCOL, ticketSubprotocol, wsPaths } from './compat.ts'
import { safeText, silentDiagnostics, type Diagnostics } from './diagnostics.ts'
import { asCindlError, NotSentError, protocolError } from './errors.ts'
import type { SocketFactory, SocketLike, Timers } from './platform.ts'
import type { RestClient } from './rest.ts'
import {
  RpcChannel,
  type HermesEventParams,
  type InboundServerRequest,
  type RpcCloseInfo,
  type UnhandledServerRequest,
} from './rpc.ts'
import { canonicalMethods, sidecarMethods } from './upstream-surface.ts'
import {
  ClientCapabilitiesResult,
  GatewayCapabilitiesResult,
  GatewayReadyPayload,
  RuntimeDescribeResult,
  parseWire,
} from './wire.ts'

/** Methods both surfaces share: the handshake and the liveness probe. */
const sharedMethods = ['client.capabilities', 'ping'] as const

export interface Handshake {
  /** Cindl's per-socket counter; open server requests are tied to it. */
  connectionEpoch: number
  /** Hermes process epoch from `gateway.ready.replay_epoch`. */
  replayEpoch: string
  /** The epoch seen on the previous socket, if any. A change means Hermes restarted. */
  previousReplayEpoch: string | undefined
  authority: AuthorityMode
  sessionAuthority: boolean
  heartbeat: boolean
  /** Server-to-client request methods Hermes may send (`client.capabilities`). */
  serverRequests: string[]
  /** Hermes counts a 4404 reply as one client declining (`declines_not_shown`). */
  declinesNotShown: boolean
  perSessionExclusiveSubmit?: boolean
  runtime?: RuntimeDescribeResult
}

export type ConnectionState =
  | { phase: 'connecting'; attempt: number }
  | { phase: 'online'; handshake: Handshake }
  | { phase: 'reconnecting'; attempt: number; retryInMs: number; lastError?: CindlError }
  | { phase: 'signed-out'; lastError: CindlError }
  | { phase: 'incompatible'; lastError: CindlError }
  | { phase: 'stopped' }

export interface ConnectionCallbacks {
  /** Runs before the state turns `online`; reconnect reconciliation goes here. */
  onReady(handshake: Handshake): Promise<void> | void
  onEvent(params: HermesEventParams, connectionEpoch: number): void
  onServerRequest(request: InboundServerRequest, connectionEpoch: number): void
  /** A request Cindl leaves to other clients or declines (see rpc.ts). */
  onUnhandledServerRequest?(
    request: UnhandledServerRequest,
    connectionEpoch: number,
  ): void
  onState(state: ConnectionState): void
}

export interface HermesConnectionOptions {
  origin: string
  rest: RestClient
  socketFactory: SocketFactory
  timers: Timers
  callbacks: ConnectionCallbacks
  diagnostics?: Diagnostics
  /** Last connection epoch used on this device, so epochs stay unique across restarts. */
  initialEpoch?: number
  /** Jitter source in [0, 1). Default Math.random. */
  random?: () => number
  connectTimeoutMs?: number
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatDeadlineMs?: number
  backoff?: { initialMs: number; maxMs: number }
  /**
   * Send `client.capabilities {server_requests: true}` (default). Only the
   * read-only live probe turns this off, so Hermes routes no requests to it.
   */
  advertiseServerRequests?: boolean
}

/** `https://host` → `wss://host/api/ws`. The ticket never goes into the URL. */
export function gatewaySocketUrl(origin: string): string {
  const url = new URL(wsPaths.gateway, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * True for answers that mean the server speaks a different contract than the
 * verified v0.22.5 one: a known method is unknown (-32601) or our params are
 * refused as out of sync (4000).
 */
export function isVersionMismatch(error: unknown): boolean {
  return (
    error instanceof CindlError &&
    (error.code === 'unsupported' || error.code === 'protocol') &&
    /: (-32601|4000)\b/.test(error.detail ?? '')
  )
}

interface OpenedSocket {
  socket: SocketLike
  buffered: unknown[]
}

class HandshakeFailure extends Error {
  readonly kind: 'retry' | 'signed-out' | 'incompatible'
  readonly error: CindlError
  constructor(kind: HandshakeFailure['kind'], error: CindlError) {
    super(error.message)
    this.kind = kind
    this.error = error
  }
}

/**
 * Owns the `/api/ws` connection lifecycle (overview: connection lifecycle):
 * mint a fresh single-use ticket, open the socket with the ticket
 * subprotocol, wait for `gateway.ready`, send `client.capabilities
 * {server_requests: true}` immediately (or Hermes withdraws approvals), select
 * the authority from the handshake, then probe without mutating anything.
 * Drops reconnect with exponential backoff and a new ticket every time.
 */
export class HermesConnection {
  readonly #options: HermesConnectionOptions
  readonly #log: Diagnostics
  #state: ConnectionState = { phase: 'stopped' }
  #channel: RpcChannel | undefined
  /** Set once the handshake completed on #channel (reconciliation may use it before `online`). */
  #live: RpcChannel | undefined
  #epoch: number
  #replayEpoch: string | undefined
  #attempt = 0
  #retryTimer: unknown
  #running = false
  #generation = 0
  #handshakeRejections = 0

  constructor(options: HermesConnectionOptions) {
    this.#options = options
    this.#log = options.diagnostics ?? silentDiagnostics
    this.#epoch = options.initialEpoch ?? 0
  }

  get state(): ConnectionState {
    return this.#state
  }

  get connectionEpoch(): number {
    return this.#epoch
  }

  get replayEpoch(): string | undefined {
    return this.#replayEpoch
  }

  /** The channel whose handshake completed; undefined while connecting or offline. */
  get channel(): RpcChannel | undefined {
    return this.#live && !this.#live.closed ? this.#live : undefined
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#attempt = 0
    void this.#connect()
  }

  stop(): void {
    this.#running = false
    this.#generation++
    this.#options.timers.clearTimeout(this.#retryTimer)
    this.#channel?.close(1000, 'client stopped')
    this.#channel = undefined
    this.#live = undefined
    this.#setState({ phase: 'stopped' })
  }

  /** Skip the backoff wait (e.g. the app returned to the foreground). */
  reconnectNow(): void {
    if (!this.#running || this.#state.phase !== 'reconnecting') return
    this.#options.timers.clearTimeout(this.#retryTimer)
    void this.#connect()
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const channel = this.channel
    if (!channel) return Promise.reject(new NotSentError(`${method}: not online`))
    return channel.request(method, params, options).catch((error: unknown) => {
      if (isVersionMismatch(error)) this.#incompatible(error as CindlError)
      throw error
    })
  }

  async #connect(): Promise<void> {
    const generation = ++this.#generation
    this.#attempt++
    this.#setState({ phase: 'connecting', attempt: this.#attempt })
    try {
      const { channel, handshake } = await this.#handshake(generation)
      if (generation !== this.#generation) {
        channel.close(1000, 'superseded')
        return
      }
      this.#attempt = 0
      this.#handshakeRejections = 0
      this.#live = channel
      try {
        await this.#options.callbacks.onReady(handshake)
      } catch (error) {
        this.#log.log('error', 'connection.on-ready-failed', {
          error: error instanceof Error ? error.name : 'unknown',
        })
      }
      if (generation !== this.#generation || channel.closed) return
      this.#setState({ phase: 'online', handshake })
      // `ping` is on the v0.22.5 contract and answered cheaply; any inbound
      // frame counts as liveness, so a streaming turn never trips the deadline.
      channel.startHeartbeat()
    } catch (error) {
      if (generation !== this.#generation) return
      const failure =
        error instanceof HandshakeFailure
          ? error
          : new HandshakeFailure('retry', asCindlError(error, 'connect'))
      this.#channel?.close(1000, 'handshake failed')
      this.#channel = undefined
      this.#live = undefined
      if (failure.kind === 'signed-out') {
        this.#running = false
        this.#options.timers.clearTimeout(this.#retryTimer)
        this.#setState({ phase: 'signed-out', lastError: failure.error })
      } else if (failure.kind === 'incompatible') {
        this.#incompatible(failure.error)
      } else this.#scheduleRetry(failure.error)
    }
  }

  async #handshake(
    generation: number,
  ): Promise<{ channel: RpcChannel; handshake: Handshake }> {
    let ticket: string
    try {
      ticket = (await this.#options.rest.wsTicket()).ticket
    } catch (error) {
      const cause = asCindlError(error, 'ws-ticket')
      if (cause.code === 'unauthenticated' || cause.code === 'forbidden')
        throw new HandshakeFailure('signed-out', cause)
      if (cause.code === 'protocol' || cause.code === 'not-found')
        throw new HandshakeFailure('incompatible', cause)
      throw new HandshakeFailure('retry', cause)
    }
    const opened = await this.#open(ticket, generation)
    const epoch = this.#epoch + 1
    const { channel, payload } = await this.#waitForReady(opened, epoch)
    const sessionAuthority = payload.session_authority === true
    const authority: AuthorityMode = sessionAuthority ? 'canonical' : 'legacy-sidecar-v8'
    channel.allow([
      ...sharedMethods,
      ...(sessionAuthority ? canonicalMethods : sidecarMethods),
    ])
    const capabilities = await this.#probe(
      channel,
      'client.capabilities',
      this.#options.advertiseServerRequests === false ? {} : { server_requests: true },
      ClientCapabilitiesResult,
    )
    // A canonical socket answers client.capabilities from the sidecar handler
    // (tui_gateway/ws_legacy_fallback.py:53-63, methods_voice.py:539), but the
    // owner settles its requests on any error reply, 4404 included
    // (gateway/session_server_requests.py:74-93): never decline there.
    channel.setDeclinesCounted(
      !sessionAuthority && capabilities.declines_not_shown === true,
    )
    const handshake: Handshake = {
      connectionEpoch: epoch,
      replayEpoch: payload.replay_epoch,
      previousReplayEpoch: this.#replayEpoch,
      authority,
      sessionAuthority,
      heartbeat: payload.heartbeat === true,
      serverRequests: capabilities.server_requests,
      declinesNotShown: capabilities.declines_not_shown === true,
    }
    if (sessionAuthority)
      handshake.runtime = await this.#probe(
        channel,
        'runtime.describe',
        {},
        RuntimeDescribeResult,
      )
    else
      handshake.perSessionExclusiveSubmit = (
        await this.#probe(channel, 'gateway.capabilities', {}, GatewayCapabilitiesResult)
      ).per_session_exclusive_submit
    this.#epoch = epoch
    this.#replayEpoch = payload.replay_epoch
    this.#log.log('info', 'connection.ready', {
      connectionEpoch: epoch,
      authority,
      serverRequests: capabilities.server_requests,
    })
    return { channel, handshake }
  }

  async #probe<T>(
    channel: RpcChannel,
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let result: unknown
    try {
      result = await channel.request(method, params)
    } catch (error) {
      const cause = asCindlError(error, method)
      throw new HandshakeFailure(
        isVersionMismatch(cause) ? 'incompatible' : 'retry',
        cause,
      )
    }
    const parsed = parseWire(schema, result)
    if (parsed === undefined)
      throw new HandshakeFailure(
        'incompatible',
        protocolError(`${method}: unexpected result`),
      )
    return parsed
  }

  #open(ticket: string, generation: number): Promise<OpenedSocket> {
    const url = gatewaySocketUrl(this.#options.origin)
    const timers = this.#options.timers
    return new Promise<OpenedSocket>((resolve, reject) => {
      let socket: SocketLike
      try {
        socket = this.#options.socketFactory(url, [
          GATEWAY_SUBPROTOCOL,
          ticketSubprotocol(ticket),
        ])
      } catch (error) {
        reject(new HandshakeFailure('retry', asCindlError(error, 'socket factory')))
        return
      }
      // Hermes writes gateway.ready right after accept; keep anything that
      // arrives before the RPC channel takes over the socket.
      const buffered: unknown[] = []
      socket.onmessage = (event) => {
        buffered.push(event.data)
      }
      let settled = false
      const finish = (error?: HandshakeFailure) => {
        if (settled) return
        settled = true
        timers.clearTimeout(timer)
        socket.onopen = null
        socket.onerror = null
        socket.onclose = null
        if (error) {
          socket.onmessage = null
          try {
            socket.close()
          } catch {
            // Never opened.
          }
          reject(error)
        } else resolve({ socket, buffered })
      }
      const timer = timers.setTimeout(
        () =>
          finish(
            new HandshakeFailure(
              'retry',
              new CindlError(
                'timeout',
                'Hermes did not open the connection in time.',
                'WebSocket open timed out',
              ),
            ),
          ),
        this.#options.connectTimeoutMs ?? 15_000,
      )
      socket.onopen = () => {
        if (generation !== this.#generation) {
          finish(new HandshakeFailure('retry', new CindlError('offline', 'Superseded.')))
          return
        }
        if (socket.protocol && socket.protocol !== GATEWAY_SUBPROTOCOL) {
          finish(
            new HandshakeFailure(
              'incompatible',
              protocolError(
                `server selected subprotocol ${safeText(socket.protocol, 60)}`,
              ),
            ),
          )
          return
        }
        finish()
      }
      // A close before open is Hermes's pre-accept refusal, which reaches the
      // client as HTTP 403 (bad/used/expired ticket, Host or Origin refused) or
      // a network failure. They are indistinguishable here; the next attempt
      // mints a new ticket, which also re-proves the session.
      const refused = (detail: string) => {
        this.#handshakeRejections++
        finish(
          new HandshakeFailure(
            'retry',
            new CindlError(
              'unavailable',
              this.#handshakeRejections >= 3
                ? 'Hermes keeps refusing the connection. Check its Host/Origin settings or proxy.'
                : 'Hermes refused the connection.',
              detail,
            ),
          ),
        )
      }
      socket.onerror = () => refused('WebSocket error before open')
      socket.onclose = (event) =>
        refused(`WebSocket closed before open (code ${event.code})`)
    })
  }

  #waitForReady(
    opened: OpenedSocket,
    epoch: number,
  ): Promise<{ channel: RpcChannel; payload: GatewayReadyPayload }> {
    const timers = this.#options.timers
    return new Promise((resolve, reject) => {
      let ready = false
      const deadline: { timer?: unknown } = {}
      const channel: RpcChannel = new RpcChannel({
        socket: opened.socket,
        timers,
        diagnostics: this.#log,
        ...(this.#options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: this.#options.requestTimeoutMs }),
        ...(this.#options.heartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: this.#options.heartbeatIntervalMs }),
        ...(this.#options.heartbeatDeadlineMs === undefined
          ? {}
          : { heartbeatDeadlineMs: this.#options.heartbeatDeadlineMs }),
        onEvent: (params) => {
          if (!ready) {
            timers.clearTimeout(deadline.timer)
            if (params.type !== 'gateway.ready') {
              reject(
                new HandshakeFailure(
                  'incompatible',
                  protocolError(`first frame was ${safeText(params.type, 60)}`),
                ),
              )
              return
            }
            const payload = parseWire(GatewayReadyPayload, params.payload)
            if (!payload) {
              reject(
                new HandshakeFailure(
                  'incompatible',
                  protocolError('gateway.ready payload did not match v0.22.5'),
                ),
              )
              return
            }
            ready = true
            resolve({ channel, payload })
            return
          }
          if (params.type === 'gateway.ready') return
          this.#options.callbacks.onEvent(params, epoch)
        },
        onServerRequest: (request) =>
          this.#options.callbacks.onServerRequest(request, epoch),
        onUnhandledServerRequest: (request) =>
          this.#options.callbacks.onUnhandledServerRequest?.(request, epoch),
        onClose: (info) => {
          if (!ready) {
            timers.clearTimeout(deadline.timer)
            reject(
              new HandshakeFailure(
                info.code === 4000 ? 'incompatible' : 'retry',
                new CindlError(
                  'offline',
                  'The Hermes connection closed during the handshake.',
                  `closed with code ${info.code}`,
                ),
              ),
            )
            return
          }
          this.#closed(channel, info)
        },
      })
      // A failed handshake must close this socket: the caller closes #channel.
      this.#channel = channel
      channel.ingest(opened.buffered)
      if (ready) return
      deadline.timer = timers.setTimeout(() => {
        reject(
          new HandshakeFailure(
            'retry',
            new CindlError(
              'timeout',
              'Hermes did not finish the handshake.',
              'no gateway.ready frame',
            ),
          ),
        )
      }, this.#options.readyTimeoutMs ?? 10_000)
    })
  }

  #closed(channel: RpcChannel, info: RpcCloseInfo): void {
    if (channel !== this.#channel) return
    this.#channel = undefined
    this.#live = undefined
    // Local closes are deliberate; whoever closed decides what happens next.
    if (!this.#running || info.initiatedBy === 'local') return
    if (info.code === 4000 && info.initiatedBy === 'remote') {
      // tui_gateway does not use 4000 on /api/ws at v0.22.5; treat it as version skew.
      this.#incompatible(
        new CindlError(
          'protocol',
          'This Hermes version closed the connection in a way v0.22.5 never does.',
          'close code 4000',
        ),
      )
      return
    }
    this.#scheduleRetry(
      new CindlError(
        'offline',
        'Lost the connection to Hermes.',
        `closed with code ${info.code} (${info.initiatedBy})`,
      ),
    )
  }

  #scheduleRetry(lastError: CindlError): void {
    if (!this.#running) return
    const { initialMs, maxMs } = this.#options.backoff ?? {
      initialMs: 1_000,
      maxMs: 30_000,
    }
    const base = Math.min(maxMs, initialMs * 2 ** Math.min(this.#attempt, 10))
    const jitter = 0.8 + 0.4 * (this.#options.random ?? Math.random)()
    const retryInMs = Math.round(base * jitter)
    this.#setState({
      phase: 'reconnecting',
      attempt: this.#attempt,
      retryInMs,
      lastError,
    })
    this.#log.log('info', 'connection.retry', { retryInMs, code: lastError.code })
    this.#options.timers.clearTimeout(this.#retryTimer)
    this.#retryTimer = this.#options.timers.setTimeout(
      () => void this.#connect(),
      retryInMs,
    )
  }

  #incompatible(lastError: CindlError): void {
    this.#running = false
    this.#generation++
    this.#options.timers.clearTimeout(this.#retryTimer)
    const channel = this.#channel
    this.#channel = undefined
    this.#live = undefined
    channel?.close(1000, 'incompatible')
    this.#log.log('warn', 'connection.incompatible', { detail: lastError.detail })
    this.#setState({ phase: 'incompatible', lastError })
  }

  #setState(state: ConnectionState): void {
    this.#state = state
    try {
      this.#options.callbacks.onState(state)
    } catch (error) {
      this.#log.log('error', 'connection.state-listener-failed', {
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
}
