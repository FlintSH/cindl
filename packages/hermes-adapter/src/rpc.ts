import { CindlError } from '@cindl/contracts'
import { safeText, silentDiagnostics, type Diagnostics } from './diagnostics.ts'
import { NotSentError, offlineError, rpcError, timeoutError } from './errors.ts'
import { SOCKET_OPEN, type SocketLike, type Timers } from './platform.ts'
import { answeredServerRequests } from './upstream-surface.ts'

/** `params` of a Hermes `event` notification (tui_gateway/server.py:717-728). */
export interface HermesEventParams {
  type: string
  session_id?: string
  seq?: number
  payload?: unknown
}

export type AnsweredMethod = (typeof answeredServerRequests)[number]

/**
 * "No window here shows this session" (tui_gateway/server_requests.py:117-121).
 * Hermes counts it as one client's vote and settles the request only when
 * every answering client declined (:254-278), so another client can still
 * answer. Sent only when `client.capabilities` reported `declines_not_shown`.
 */
export const NOT_SHOWN_CODE = 4404

/**
 * Bridges answered by the window that shows the session; any other client
 * declines with 4404 (apps/desktop .../gateway-event/server-requests.ts
 * `WINDOW_OWNED_REQUESTS` at v0.22.5). A unanimous decline settles them with a
 * "no window is showing this chat" result, which these tools report as such.
 */
export const windowOwnedRequests = [
  'preview.act',
  'preview.read',
  'terminal.read',
  'theme.apply',
  'window.read',
  'tour',
] as const

/**
 * What Cindl does with a server request it does not answer. Hermes delivers
 * each request to every attached client and the FIRST reply wins, so an error
 * reply would close the request for a client that can answer it
 * (server_requests.py:281-317). Credential prompts (secret, sudo, vault.*,
 * display.install.sudo) must not be declined either: a unanimous decline
 * settles with a "not shown" value that `_ask` hands back as the answer
 * (tui_gateway/agent_callbacks.py:244-283). Those stay unanswered: another
 * client answers them, or Hermes's own deadline fails them closed.
 */
export function unhandledRequestAction(
  method: string,
  declinesCounted: boolean,
): 'decline' | 'leave-open' {
  return declinesCounted && (windowOwnedRequests as readonly string[]).includes(method)
    ? 'decline'
    : 'leave-open'
}

export interface UnhandledServerRequest {
  id: string
  method: string
  sessionId: string | undefined
  replayed: boolean
  action: 'decline' | 'leave-open'
}

/**
 * One server-to-client request (tui_gateway/server_requests.py). Answer it by
 * calling `respond` or `fail` exactly once; the frame goes out on the channel
 * that received the request and reuses its JSON-RPC id. Later calls return
 * false and send nothing.
 */
export interface InboundServerRequest {
  readonly id: string
  readonly method: AnsweredMethod
  readonly params: Record<string, unknown>
  /** Delivered from a reconnect snapshot (`open_requests`) rather than live. */
  readonly replayed: boolean
  readonly settled: boolean
  respond(result: Record<string, unknown>): boolean
  fail(code: number, message: string): boolean
}

export interface RpcCloseInfo {
  code: number
  reason: string
  initiatedBy: 'remote' | 'heartbeat' | 'local'
}

export interface RpcChannelOptions {
  socket: SocketLike
  timers: Timers
  diagnostics?: Diagnostics
  /** Per-request deadline. Default 30 s. */
  requestTimeoutMs?: number
  /** `ping` cadence; 0 disables the heartbeat. Default 15 s. */
  heartbeatIntervalMs?: number
  /** Silence (no inbound frame of any kind) that counts as a dead socket. Default 45 s. */
  heartbeatDeadlineMs?: number
  onEvent(params: HermesEventParams): void
  onServerRequest(request: InboundServerRequest): void
  /** A request Cindl does not answer (declined or left open for another client). */
  onUnhandledServerRequest?(request: UnhandledServerRequest): void
  onClose(info: RpcCloseInfo): void
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: CindlError): void
  timer: unknown
}

const decoder = new TextDecoder()

/** Close code Cindl uses when it gives up on a silent socket (any 4xxx is private use). */
export const HEARTBEAT_CLOSE_CODE = 4100

function frameText(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return decoder.decode(data)
  if (ArrayBuffer.isView(data))
    return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * JSON-RPC 2.0 over one Hermes `/api/ws` socket: one JSON object per text
 * frame (tui_gateway/ws.py). Client ids are integers so they can never
 * collide with Hermes's `srq-` server-request ids. Only methods in
 * `allowedMethods` may be sent; the connection sets that list to the sidecar
 * or the canonical surface, never both.
 */
export class RpcChannel {
  readonly #socket: SocketLike
  readonly #timers: Timers
  readonly #log: Diagnostics
  readonly #options: RpcChannelOptions
  readonly #pending = new Map<number, Pending>()
  readonly #answered = new Set<string>()
  #allowed: ReadonlySet<string> = new Set()
  #declinesCounted = false
  #nextId = 0
  #closed = false
  #lastInbound: number
  #heartbeat: unknown

  constructor(options: RpcChannelOptions) {
    this.#options = options
    this.#socket = options.socket
    this.#timers = options.timers
    this.#log = options.diagnostics ?? silentDiagnostics
    this.#lastInbound = this.#timers.now()
    this.#socket.onmessage = (event) => this.#receive(event.data)
    this.#socket.onclose = (event) =>
      this.#finish({ code: event.code, reason: event.reason, initiatedBy: 'remote' })
    this.#socket.onerror = () => this.#log.log('warn', 'rpc.socket-error')
  }

  /** Process frames that arrived before this channel took over the socket, in order. */
  ingest(frames: readonly unknown[]): void {
    for (const data of frames) this.#receive(data)
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Restrict outgoing methods (sidecar or canonical surface). */
  allow(methods: Iterable<string>): void {
    this.#allowed = new Set(methods)
  }

  /** From `client.capabilities` → `declines_not_shown`: Hermes counts 4404 as a decline. */
  setDeclinesCounted(value: boolean): void {
    this.#declinesCounted = value
  }

  /**
   * Answer a server request by its id on this channel. Hermes resolves answers
   * by id across connections, so a request re-delivered after a reconnect can
   * be answered here. `duplicate`: this channel already answered that id;
   * `not-sent`: the socket is not open, nothing left this device.
   */
  respondTo(
    id: string,
    result: Record<string, unknown>,
  ): 'sent' | 'duplicate' | 'not-sent' {
    if (this.#answered.has(id)) return 'duplicate'
    if (!this.#send({ jsonrpc: '2.0', id, result })) return 'not-sent'
    this.#answered.add(id)
    return 'sent'
  }

  startHeartbeat(): void {
    const interval = this.#options.heartbeatIntervalMs ?? 15_000
    if (interval <= 0 || this.#closed) return
    const deadline = this.#options.heartbeatDeadlineMs ?? 45_000
    const tick = () => {
      if (this.#closed) return
      if (this.#timers.now() - this.#lastInbound >= deadline) {
        this.#log.log('warn', 'rpc.heartbeat-timeout')
        this.close(HEARTBEAT_CLOSE_CODE, 'heartbeat timeout', 'heartbeat')
        return
      }
      this.request('ping', {}, { timeoutMs: deadline }).catch(() => undefined)
      this.#heartbeat = this.#timers.setTimeout(tick, interval)
    }
    this.#heartbeat = this.#timers.setTimeout(tick, interval)
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new NotSentError(`${method}: socket closed`))
    if (!this.#allowed.has(method))
      return Promise.reject(
        new CindlError(
          'protocol',
          'Cindl tried an operation this connection does not allow.',
          `${method} is not on the negotiated Hermes surface`,
        ),
      )
    const id = ++this.#nextId
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs ?? 30_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        if (this.#pending.delete(id)) reject(timeoutError(`${method}: no answer`))
      }, timeoutMs)
      this.#pending.set(id, { method, resolve, reject, timer })
      if (!this.#send({ jsonrpc: '2.0', id, method, params })) {
        this.#timers.clearTimeout(timer)
        this.#pending.delete(id)
        reject(new NotSentError(`${method}: send failed`))
      }
    })
  }

  /** Re-deliver server requests listed in a reconnect snapshot (`open_requests`). */
  deliverOpenRequests(
    entries: ReadonlyArray<{ id: string; method: string; params: unknown }>,
  ) {
    for (const entry of entries)
      this.#serverRequest(
        entry.id,
        entry.method,
        isRecord(entry.params) ? entry.params : {},
        true,
      )
  }

  close(
    code = 1000,
    reason = 'client closing',
    initiatedBy: RpcCloseInfo['initiatedBy'] = 'local',
  ) {
    if (this.#closed) return
    this.#finish({ code, reason, initiatedBy })
    try {
      this.#socket.close(code >= 4000 || code === 1000 ? code : 1000, reason)
    } catch {
      // Already closed.
    }
  }

  #send(frame: Record<string, unknown>): boolean {
    if (this.#closed || this.#socket.readyState !== SOCKET_OPEN) return false
    try {
      this.#socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  #receive(data: unknown): void {
    if (this.#closed) return
    this.#lastInbound = this.#timers.now()
    const text = frameText(data)
    if (text === undefined) {
      this.#log.log('warn', 'rpc.non-text-frame')
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      this.#log.log('warn', 'rpc.unparseable-frame', { length: text.length })
      return
    }
    if (!isRecord(frame)) return
    const { id, method } = frame
    if (typeof method === 'string' && typeof id === 'string' && method !== 'event') {
      this.#serverRequest(id, method, isRecord(frame.params) ? frame.params : {}, false)
      return
    }
    if ((typeof id === 'number' || typeof id === 'string') && method === undefined) {
      this.#response(id, frame)
      return
    }
    if (
      method === 'event' &&
      isRecord(frame.params) &&
      typeof frame.params.type === 'string'
    )
      this.#event(frame.params)
  }

  #response(id: number | string, frame: Record<string, unknown>): void {
    if (typeof id !== 'number') return
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    this.#timers.clearTimeout(pending.timer)
    if ('error' in frame) {
      const error = isRecord(frame.error) ? frame.error : {}
      this.#log.log('info', 'rpc.error-response', {
        method: pending.method,
        code: typeof error.code === 'number' ? error.code : undefined,
      })
      pending.reject(rpcError(error, pending.method))
    } else pending.resolve(frame.result)
  }

  #event(params: Record<string, unknown>): void {
    try {
      this.#options.onEvent(params as unknown as HermesEventParams)
    } catch (error) {
      this.#log.log('error', 'rpc.event-handler-failed', {
        type: safeText(params.type, 80),
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  #serverRequest(
    id: string,
    method: string,
    params: Record<string, unknown>,
    replayed: boolean,
  ): void {
    let settled = false
    const settle = (frame: Record<string, unknown>) => {
      if (settled || this.#answered.has(id)) return false
      settled = true
      this.#answered.add(id)
      return this.#send({ jsonrpc: '2.0', id, ...frame })
    }
    if (!(answeredServerRequests as readonly string[]).includes(method)) {
      const action = unhandledRequestAction(method, this.#declinesCounted)
      if (action === 'decline')
        settle({
          error: { code: NOT_SHOWN_CODE, message: 'Cindl is not showing this session.' },
        })
      this.#log.log('info', 'rpc.server-request-not-answered', {
        method: safeText(method, 80),
        action,
      })
      try {
        this.#options.onUnhandledServerRequest?.({
          id,
          method,
          sessionId:
            typeof params.session_id === 'string' ? params.session_id : undefined,
          replayed,
          action,
        })
      } catch {
        // Notification only.
      }
      return
    }
    const request: InboundServerRequest = {
      id,
      method: method as AnsweredMethod,
      params,
      replayed,
      get settled() {
        return settled
      },
      respond: (result) => settle({ result }),
      fail: (code, message) => settle({ error: { code, message } }),
    }
    try {
      this.#options.onServerRequest(request)
    } catch (error) {
      // Never answer on a handler crash: an error reply would close the
      // request for every other client. It stays open for them or times out.
      this.#log.log('error', 'rpc.server-request-handler-failed', {
        method,
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  #finish(info: RpcCloseInfo): void {
    if (this.#closed) return
    this.#closed = true
    this.#timers.clearTimeout(this.#heartbeat)
    this.#socket.onmessage = null
    this.#socket.onclose = null
    this.#socket.onerror = null
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      this.#timers.clearTimeout(pending.timer)
      pending.reject(offlineError(`${pending.method}: connection closed`))
    }
    this.#log.log('info', 'rpc.closed', {
      code: info.code,
      reason: safeText(info.reason, 120),
      initiatedBy: info.initiatedBy,
    })
    this.#options.onClose({ ...info, reason: safeText(info.reason, 120) })
  }
}
