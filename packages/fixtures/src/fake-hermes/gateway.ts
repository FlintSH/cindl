/**
 * TEST-ONLY emulation of the Hermes v0.22.5 `/api/ws` JSON-RPC sidecar
 * (tui_gateway/ws.py, server.py, server_requests.py, event_replay.py,
 * methods_session.py). It implements the subset Cindl uses, faithfully enough
 * that the adapter is exercised against real protocol rules: `gateway.ready`
 * first, unknown params keys answered with 4000, unknown methods with -32601,
 * per-session `seq` stamping and a bounded replay ring with a process epoch,
 * server-to-client requests with `srq-` ids that are re-listed in
 * `open_requests` until answered, `request.cancel` on withdrawal, and runtime
 * session ids that differ from stored ids. Every frame it sends is validated
 * against the vendored contract; violations are recorded, not hidden.
 *
 * Not Hermes. Synthetic data only.
 */
import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { FakeAuth, FakeClock } from './auth.ts'
import type { HermesContract } from './contract.ts'
import { hex, type FixtureStore, type StoredSession } from './store.ts'
import { createSyntheticScreen, type SyntheticScreen } from '../scenario/screen.ts'
import { RfbClientFilter } from './rfb-filter.ts'

export interface FakeCall {
  kind: 'rest' | 'rpc' | 'ws'
  name: string
}

type Json = Record<string, unknown>

export interface ApprovalWire {
  command: string
  description: string
  choices: Array<'once' | 'session' | 'always' | 'deny'>
  allow_permanent: boolean
  allow_session: boolean
  smart_denied: boolean
  tool_name: string
}

export interface ClarifyQuestionWire {
  qid: string
  question: string
  choices?: string[] | null
  multi_select?: boolean
}

export interface TurnContext {
  readonly sid: string
  readonly storedId: string
  readonly text: string
  readonly interrupted: boolean
  emit(type: string, payload: Json): void
  wait(ms: number): Promise<void>
  /** Resolves with the client's result, or null when withdrawn, refused or timed out (Hermes then denies). */
  approval(params?: Partial<ApprovalWire>): Promise<Json | null>
  clarify(questions: ClarifyQuestionWire[]): Promise<Json | null>
  /** message.start → deltas → message.complete, persisted to the transcript. */
  reply(text: string): Promise<void>
}

export type TurnScript = (turn: TurnContext) => Promise<void>

export const defaultScript: TurnScript = async (turn) => {
  await turn.reply(`Synthetic reply (fixture) to: ${turn.text.slice(0, 40)}`)
}

interface OpenRequest {
  id: string
  method: string
  sid: string
  params: Json
  requestId?: string
  createdAt: number
  declined: Set<FakeConnection>
  /** Batch clarify: answers locked so far (server_requests.py:319-336). */
  locked?: Record<string, string | null>
  settle(result: Json | null): void
}

/** How a server request ended, for assertions. */
export interface SettledRequest {
  id: string
  method: string
  outcome: 'answered' | 'error' | 'declined-by-all' | 'cancelled' | 'timeout'
  /** Connection id whose frame settled it. */
  by?: number
  result?: Json | null
}

/** tui_gateway/server_requests.py:119-121. */
export const NOT_SHOWN_MESSAGE =
  'No Hermes Desktop window is showing this chat, so its preview, terminal and tour are out of reach. Ask the user to open this chat in the Desktop app, then retry.'

interface LiveSession {
  sid: string
  storedId: string
  pendingTitle?: string
  profile: string
  /** Every attached client (session.resume attaches alongside existing ones). */
  connections: Set<FakeConnection>
  closeOnDisconnect: boolean
  running: boolean
  interrupted: boolean
  queue: string[]
  reapTimer?: ReturnType<typeof setTimeout>
}

export type FailMode =
  | 'drop-before-response'
  | 'drop-after-response'
  | 'error-5000'
  /** Answer as a build without this method would (-32601). */
  | 'unknown-method'
  /** Answer as a build with a different params model would (4000). */
  | 'params-out-of-sync'
  /** Never answer (the request times out on the client). */
  | 'no-response'

/** One `/api/display/ws` viewer on the fake. */
export interface DisplayViewer {
  readonly ws: WebSocket
  readonly viewerId: string
  /** Held control during this connection (display.py:46-58). */
  heldEver: boolean
  /** Counts of input passed and dropped by the lease gate. */
  readonly filter: RfbClientFilter
  /** The close code the viewer's socket ended with, once it has. */
  closedWith?: number
  /** Hermes closed it (an eviction, a protocol error, the end of the RFB stream). */
  closedByServer?: boolean
}

/** A second synthetic profile on the same Hermes; real keys are host paths. */
export const OTHER_PROFILE_KEY = 'fixture-other-profile'

let connectionIds = 0

export class FakeConnection {
  readonly id = ++connectionIds
  readonly socket: WebSocket
  answersRequests = false
  readonly viewerIds = new Set<string>()
  readonly #gateway: FakeGateway

  constructor(socket: WebSocket, gateway: FakeGateway) {
    this.socket = socket
    this.#gateway = gateway
  }

  get open(): boolean {
    return this.socket.readyState === 1
  }

  send(frame: Json): void {
    this.#gateway.checkOutgoing(frame)
    if (this.open && !this.#gateway.frozen) this.socket.send(JSON.stringify(frame))
  }
}

const ok = (id: unknown, result: unknown): Json => ({ jsonrpc: '2.0', result, id })
/** A string param, or the fallback for anything else. */
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback
const err = (id: unknown, code: number, message: string, data?: unknown): Json => ({
  jsonrpc: '2.0',
  error: { code, message, ...(data === undefined ? {} : { data }) },
  id,
})

const SERVER_REQUEST_METHODS = [
  'approval',
  'clarify',
  'display.install.sudo',
  'preview.act',
  'preview.read',
  'secret',
  'setup_beat',
  'sudo',
  'terminal.read',
  'theme.apply',
  'theme.pick',
  'tour',
  'vault.code',
  'vault.save_login',
  'vault.unlock_prompt',
  'window.read',
]

export class FakeGateway {
  epoch = hex(16)
  ringMax = 512
  reapGraceMs = 20_000
  sessionAuthority = false
  /** When true the server reads nothing and writes nothing: a silently dead socket. */
  frozen = false
  /** Test hook awaited before a request is handled (delays, interleavings). */
  beforeHandle: ((method: string, params: Json) => Promise<void> | void) | undefined
  /**
   * Test hook run after a request was handled and before its reply is written:
   * what happens there is newer than the reply, as when another Hermes thread
   * writes a frame while a handler finishes.
   */
  afterHandle: ((method: string, params: Json) => void) | undefined
  /** Test hook: answer a request with this JSON-RPC error instead of handling it. */
  respondError:
    | ((method: string, params: Json) => { code: number; message: string } | undefined)
    | undefined
  script: TurnScript = defaultScript
  readonly connections = new Set<FakeConnection>()
  readonly live = new Map<string, LiveSession>()
  readonly open = new Map<string, OpenRequest>()
  readonly settled: SettledRequest[] = []
  /** `client.capabilities` params per call, to check what each client advertised. */
  readonly advertisements: Json[] = []
  readonly droppedResponses: string[] = []
  readonly failNext = new Map<string, FailMode>()
  /** Open `/api/display/ws` viewers, one RFB session each over the synthetic screen. */
  readonly displayViewers = new Set<DisplayViewer>()
  #screen: SyntheticScreen | undefined
  readonly #rings = new Map<string, Array<{ seq: number; params: Json }>>()
  readonly #nextSeq = new Map<string, number>()
  readonly #evictedThrough = new Map<string, number>()
  readonly #idempotency = new Map<string, string>()
  readonly #store: FixtureStore
  readonly #auth: FakeAuth
  readonly #contract: HermesContract
  readonly #clock: FakeClock
  readonly #calls: FakeCall[]
  readonly #violations: string[]

  constructor(deps: {
    store: FixtureStore
    auth: FakeAuth
    contract: HermesContract
    clock: FakeClock
    calls: FakeCall[]
    violations: string[]
  }) {
    this.#store = deps.store
    this.#auth = deps.auth
    this.#contract = deps.contract
    this.#clock = deps.clock
    this.#calls = deps.calls
    this.#violations = deps.violations
  }

  // --- connection lifecycle -----------------------------------------------

  attach(socket: WebSocket): FakeConnection {
    const connection = new FakeConnection(socket, this)
    this.connections.add(connection)
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8')
      void this.#receive(connection, text)
    })
    socket.on('close', () => this.#detach(connection))
    connection.send({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'gateway.ready',
        payload: {
          skin: {},
          change_events: true,
          heartbeat: true,
          replay_epoch: this.epoch,
          ...(this.sessionAuthority ? { session_authority: true } : {}),
        },
      },
    })
    return connection
  }

  /** Simulate a backend restart: sockets drop, runtime state and the epoch are new. */
  restart(): void {
    for (const connection of this.connections) connection.socket.terminate()
    this.connections.clear()
    for (const live of this.live.values()) clearTimeout(live.reapTimer)
    this.live.clear()
    this.open.clear()
    this.#rings.clear()
    this.#nextSeq.clear()
    this.#evictedThrough.clear()
    this.epoch = hex(16)
  }

  /** Simulate a network drop: sockets die without a close frame. */
  dropConnections(): void {
    for (const connection of [...this.connections]) connection.socket.terminate()
  }

  #detach(connection: FakeConnection): void {
    this.connections.delete(connection)
    for (const live of this.live.values()) {
      if (!live.connections.delete(connection) || live.connections.size) continue
      if (live.closeOnDisconnect) this.#reap(live.sid, 'ws_disconnect')
      else
        live.reapTimer = setTimeout(
          () => this.#reap(live.sid, 'ws_orphan_reap'),
          this.reapGraceMs,
        )
    }
  }

  #reap(sid: string, reason: string): void {
    const live = this.live.get(sid)
    if (!live || live.connections.size) return
    this.cancelRequests(sid, reason)
    this.live.delete(sid)
    this.#rings.delete(sid)
    this.#evictedThrough.set(sid, this.#nextSeq.get(sid) ?? 0)
  }

  // --- outgoing frames ----------------------------------------------------

  /**
   * Validate an outgoing frame against the vendored subset. Kinds outside the
   * subset (e.g. `sudo` requests a test sends to prove Cindl leaves them
   * alone) have no vendored schema and are not checked.
   */
  checkOutgoing(frame: Json): void {
    const violation = (errors: string[]) => this.#violations.push(...errors)
    if (frame.method === 'event') {
      const params = frame.params as Json
      const type = String(params.type)
      if (!this.#contract.has('notifications', type)) return
      const check = this.#contract.notification(type, params.payload)
      if (!check.ok) violation(check.errors)
    } else if (typeof frame.method === 'string' && typeof frame.id === 'string') {
      if (!this.#contract.has('serverRequests', frame.method)) return
      const check = this.#contract.serverRequestParams(frame.method, frame.params)
      if (!check.ok) violation(check.errors)
    }
  }

  #checkResult(method: string, result: unknown): void {
    const canonical =
      this.sessionAuthority && this.#contract.has('canonicalMethods', method)
    const check = this.#contract.methodResult(method, result, canonical)
    if (!check.ok) this.#violations.push(...check.errors)
  }

  /** Stamp, record in the ring and deliver a session event (server.py write_json). */
  emit(sid: string, type: string, payload: Json): void {
    const seq = (this.#nextSeq.get(sid) ?? 0) + 1
    this.#nextSeq.set(sid, seq)
    const params: Json = { type, session_id: sid, payload, seq }
    const ring = this.#rings.get(sid) ?? []
    ring.push({ seq, params: structuredClone(params) })
    while (ring.length > this.ringMax) {
      const evicted = ring.shift()
      if (evicted)
        this.#evictedThrough.set(
          sid,
          Math.max(this.#evictedThrough.get(sid) ?? 0, evicted.seq),
        )
    }
    this.#rings.set(sid, ring)
    for (const connection of this.live.get(sid)?.connections ?? [])
      connection.send({ jsonrpc: '2.0', method: 'event', params })
  }

  /** Session-less global event: no seq, every connection (server.py _broadcast_global_event). */
  broadcast(type: string, payload: Json): void {
    for (const connection of this.connections)
      connection.send({
        jsonrpc: '2.0',
        method: 'event',
        params: { type, session_id: '', payload },
      })
  }

  // --- server-to-client requests -----------------------------------------

  /** Answering clients attached to a session (server_requests `_clients`). */
  #answering(sid: string): FakeConnection[] {
    return [...(this.live.get(sid)?.connections ?? [])].filter(
      (c) => c.answersRequests && c.open,
    )
  }

  /**
   * Send one server request to every answering client of the session; the
   * first response settles it (server_requests.py:281-317). Resolves with the
   * result, or null when nobody could be asked, an error reply arrived, or it
   * was withdrawn.
   */
  serverRequest(
    sid: string,
    method: string,
    params: Json,
    requestId?: string,
  ): Promise<Json | null> {
    return new Promise((resolve) => {
      const attached = [...(this.live.get(sid)?.connections ?? [])].filter((c) => c.open)
      const clients = attached.filter((c) => c.answersRequests)
      // session_transports.py:58-67: with clients attached but none answering, nothing is
      // sent and the wait fails at once. With no client attached the request is registered
      // and waits in open_requests for a reconnect.
      if (attached.length && !clients.length) {
        resolve(null)
        return
      }
      const id = `srq-${hex(6)}`
      const request: OpenRequest = {
        id,
        method,
        sid,
        params,
        createdAt: this.#clock.now(),
        declined: new Set(),
        settle: resolve,
        ...(requestId ? { requestId } : {}),
        ...(method === 'clarify' ? { locked: {} } : {}),
      }
      this.open.set(id, request)
      for (const client of clients)
        client.send({
          jsonrpc: '2.0',
          id,
          method,
          params: { session_id: sid, ...params },
        })
    })
  }

  /**
   * An app-level prompt (empty session_id, like display.install.sudo): registered for
   * every connection's `session.events.since {session_id: ""}` but written only to `to`,
   * the connection that started the operation (server_requests.py:166-188). Without `to`
   * another surface started it and no connection here receives the frame.
   */
  appRequest(method: string, params: Json, to?: FakeConnection): Promise<Json | null> {
    return new Promise((resolve) => {
      const id = `srq-${hex(6)}`
      this.open.set(id, {
        id,
        method,
        sid: '',
        params,
        createdAt: this.#clock.now(),
        declined: new Set(),
        settle: resolve,
      })
      to?.send({ jsonrpc: '2.0', id, method, params: { session_id: '', ...params } })
    })
  }

  /**
   * Test control: another client locks one clarify answer (`clarify.lock`). The last
   * lock settles the batch as submitted (server_requests.py:319-336).
   */
  lockClarify(id: string, qid: string, answer: string | null): void {
    const request = this.open.get(id)
    if (!request?.locked) return
    request.locked[qid] = answer
    const questions = (request.params.questions ?? []) as Array<{ qid?: unknown }>
    if (
      !questions.every(
        (q) => typeof q.qid === 'string' && q.qid in (request.locked ?? {}),
      )
    )
      return
    this.open.delete(id)
    const result = { answers: { ...request.locked }, outcome: 'submitted' }
    this.settled.push({ id, method: request.method, outcome: 'answered', result })
    request.settle(result)
  }

  /**
   * Test control: an approval resolved from another surface (`approval.respond`, a chat
   * platform, `/approve`) while the request is still open. It is withdrawn with
   * `request.cancel {reason: resolved}` (approval_gateway_wait.py:209-221).
   */
  resolveElsewhere(id: string, choice: 'once' | 'deny' = 'deny'): void {
    const request = this.open.get(id)
    if (!request) return
    this.open.delete(id)
    request.settle({ choice })
    this.settled.push({ id, method: request.method, outcome: 'cancelled' })
    this.emit(request.sid, 'request.cancel', {
      id,
      method: request.method,
      reason: 'resolved',
    })
  }

  #serverRequestFor(
    sid: string,
    method: 'approval' | 'clarify',
    params: Json,
    requestId?: string,
  ) {
    return this.serverRequest(sid, method, params, requestId)
  }

  /** server_requests.cancel: withdraw open requests and announce each with request.cancel. */
  cancelRequests(sid: string, reason: string): number {
    const targets = [...this.open.values()].filter((r) => r.sid === sid)
    const approvals = targets.filter((r) => r.method === 'approval' && r.requestId)
    for (const request of targets) {
      this.open.delete(request.id)
      request.settle(null)
      this.settled.push({ id: request.id, method: request.method, outcome: 'cancelled' })
      this.emit(sid, 'request.cancel', { id: request.id, method: request.method, reason })
    }
    if (approvals.length) {
      const live = this.live.get(sid)
      this.emit(sid, 'approval.cancelled', {
        session_id: sid,
        stored_session_id: live?.storedId ?? '',
        reason,
        cancelled_count: approvals.length,
        request_ids: approvals.map((r) => r.requestId as string),
      })
    }
    return targets.length
  }

  /** Test control: let one open request time out (Hermes fails closed). */
  expireRequest(id: string): void {
    const request = this.open.get(id)
    if (!request) return
    this.open.delete(id)
    request.settle(null)
    this.settled.push({ id, method: request.method, outcome: 'timeout' })
    this.emit(request.sid, 'request.cancel', {
      id,
      method: request.method,
      reason: 'timeout',
    })
  }

  #openRequestsFor(sid: string): Json[] {
    return [...this.open.values()]
      .filter((r) => r.sid === sid)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({
        id: r.id,
        method: r.method,
        // ServerRequest.snapshot (server_requests.py:93-99): locked batch answers ride along.
        params: {
          session_id: sid,
          ...r.params,
          ...(r.locked && Object.keys(r.locked).length
            ? { answers: { ...r.locked } }
            : {}),
        },
      }))
  }

  #resolveResponse(frame: Json, connection: FakeConnection | undefined): void {
    const id = String(frame.id)
    const request = this.open.get(id)
    if (!request) {
      // server_requests.resolve_response: a late or duplicate answer is dropped.
      this.droppedResponses.push(id)
      return
    }
    const error = frame.error as { code?: unknown } | undefined
    if (error && error.code === 4404) {
      // _decline: one client's vote; settles only once every answering client declined.
      if (connection) request.declined.add(connection)
      const clients = this.#answering(request.sid)
      if (
        !connection ||
        !clients.length ||
        !clients.every((c) => request.declined.has(c))
      )
        return
      this.open.delete(id)
      const result = {
        value: JSON.stringify({ success: false, error: NOT_SHOWN_MESSAGE }),
      }
      this.settled.push({
        id,
        method: request.method,
        outcome: 'declined-by-all',
        result,
      })
      request.settle(result)
      return
    }
    this.open.delete(id)
    if (error) {
      this.settled.push({
        id,
        method: request.method,
        outcome: 'error',
        ...(connection ? { by: connection.id } : {}),
        result: null,
      })
      request.settle(null)
      return
    }
    if (this.#contract.has('serverRequests', request.method)) {
      const check = this.#contract.serverRequestResult(request.method, frame.result)
      if (!check.ok) this.#violations.push(...check.errors)
    }
    let result = (frame.result ?? {}) as Json
    if (request.locked) {
      // tools/clarify_batch.py:27-31: the frame's answers lay over the locks; no answers = cancel-all.
      const { answers, outcome } = result
      result =
        answers && typeof answers === 'object' && !Array.isArray(answers)
          ? {
              ...result,
              answers: { ...request.locked, ...(answers as Json) },
              outcome:
                outcome === 'timed_out' || outcome === 'cancelled'
                  ? outcome
                  : 'submitted',
            }
          : { answers: { ...request.locked }, outcome: 'cancelled' }
    }
    this.settled.push({
      id,
      method: request.method,
      outcome: 'answered',
      ...(connection ? { by: connection.id } : {}),
      result,
    })
    request.settle(result)
  }

  // --- the agent screen (hermes_cli/web_routers/display.py) ------------------

  #holds(viewerId: string): boolean {
    const display = this.#store.display
    return display.holder === 'human' && display.holderViewerId === viewerId
  }

  /**
   * One `/api/display/ws` viewer: the synthetic screen's RFB session behind a
   * lease-gated input filter (display.py:121-212). Closing the window cleanly
   * hands control back; a dropped link keeps it (display.py:234-240).
   */
  attachDisplayViewer(ws: WebSocket, viewerId: string): DisplayViewer {
    const screen = (this.#screen ??= createSyntheticScreen())
    const filter = new RfbClientFilter(() => this.#holds(viewerId))
    const viewer: DisplayViewer = {
      ws,
      viewerId,
      heldEver: this.#holds(viewerId),
      filter,
    }
    this.displayViewers.add(viewer)
    const session = screen.connect((bytes) => {
      if (ws.readyState === 1) ws.send(bytes, { binary: true })
    })
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.#closeViewer(viewer, 1003, 'RFB is binary')
        return
      }
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data)
      let allowed: Uint8Array
      try {
        allowed = filter.feed(
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        )
      } catch {
        this.#closeViewer(viewer, 1003, 'malformed RFB')
        return
      }
      if (allowed.length) session.receive(allowed)
    })
    ws.on('close', (code) => {
      viewer.closedWith = code
      this.displayViewers.delete(viewer)
      // Only the viewer closing its window hands control back; a close
      // Hermes started does not (display.py:189-196, 234-240).
      if (
        !viewer.closedByServer &&
        (code === 1000 || code === 1001) &&
        this.#holds(viewerId)
      )
        this.#handBack()
    })
    return viewer
  }

  #closeViewer(viewer: DisplayViewer, code: number, reason: string): void {
    viewer.closedByServer = true
    viewer.ws.close(code, reason)
  }

  /** A lease change evicts a viewer that held control and lost it to another human (display.py:46-58). */
  #leaseChanged(): void {
    for (const viewer of this.displayViewers) {
      const display = this.#store.display
      if (display.holder !== 'human') viewer.heldEver = false
      else if (display.holderViewerId === viewer.viewerId) viewer.heldEver = true
      else if (viewer.heldEver) this.#closeViewer(viewer, 4000, 'control-taken')
    }
  }

  #handBack(): void {
    const display = this.#store.display
    display.holder = 'agent'
    display.holderViewerId = undefined
    display.since = this.#clock.now() / 1000
    display.epoch += 1
    this.broadcast('display.lease', {
      profile_key: 'fixture-profile',
      lease: this.#lease(),
    })
    this.#leaseChanged()
  }

  /**
   * Test control: the screen stops outside Cindl while viewers watch. The
   * bridge closes them with 1000 and the runtime watcher broadcasts the new
   * state (tui_gateway/methods_display_watch.py:81-103).
   */
  stopScreen(): void {
    this.#store.display.running = false
    // The RFB stream ends and the bridge closes with a plain 1000
    // (display.py:181-185, 241-244); 4001 is only for a socket opening.
    for (const viewer of this.displayViewers) this.#closeViewer(viewer, 1000, '')
    this.broadcast('display.status', this.#displaySnapshot())
  }

  /**
   * Test control: another profile's screen changes. Hermes broadcasts display
   * events for every profile to every client (methods_display.py:38-47,
   * methods_display_watch.py:81-103); only `profile_key` tells them apart.
   */
  otherProfileDisplay(change: { running: boolean; holder: 'agent' | 'human' }): void {
    const lease = {
      holder: change.holder,
      viewer_id: null,
      viewer_hash: change.holder === 'human' ? '0123456789ab' : null,
      since: this.#clock.now() / 1000,
      epoch: 1,
      reason: '',
    }
    this.broadcast('display.lease', { profile_key: OTHER_PROFILE_KEY, lease })
    this.broadcast('display.status', {
      ...this.#displaySnapshot(),
      profile: 'other',
      running: change.running,
      lease,
      profile_key: OTHER_PROFILE_KEY,
    })
  }

  /** Test control: the screen starts outside Cindl (the CLI or the agent started it). */
  startScreen(): void {
    this.#store.display.running = true
    this.broadcast('display.status', this.#displaySnapshot())
  }

  // --- turns ----------------------------------------------------------------

  #storedFor(live: LiveSession): StoredSession {
    let stored = this.#store.sessions.get(live.storedId)
    if (!stored) {
      // A DB row appears on the first prompt (SessionCreateResult docs).
      stored = {
        id: live.storedId,
        title: live.pendingTitle ?? '',
        preview: '',
        startedAt: this.#clock.now() / 1000,
        source: 'desktop',
        profile: live.profile,
        revision: 1,
        generation: 1,
        archived: false,
        rows: [],
      }
      this.#store.sessions.set(stored.id, stored)
    }
    return stored
  }

  #appendRow(
    stored: StoredSession,
    row: Omit<StoredSession['rows'][number], 'row_id' | 'timestamp'>,
  ) {
    const rowId = (stored.rows.at(-1)?.row_id ?? 0) + 1
    stored.rows.push({ ...row, row_id: rowId, timestamp: this.#clock.now() / 1000 })
    return rowId
  }

  #startTurn(live: LiveSession, text: string): void {
    live.running = true
    live.interrupted = false
    const stored = this.#storedFor(live)
    const context: TurnContext = {
      sid: live.sid,
      storedId: live.storedId,
      text,
      get interrupted() {
        return live.interrupted
      },
      emit: (type, payload) => this.emit(live.sid, type, payload),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      approval: (params = {}) => {
        const requestId = hex(16)
        return this.#serverRequestFor(
          live.sid,
          'approval',
          {
            request_id: requestId,
            command: 'ls /srv/hermes-fixture/reports',
            description: 'List the synthetic report folder (fixture)',
            choices: ['once', 'session', 'always', 'deny'],
            allow_permanent: true,
            allow_session: true,
            smart_denied: false,
            tool_name: 'terminal',
            ...params,
          },
          requestId,
        )
      },
      clarify: (questions) => this.#serverRequestFor(live.sid, 'clarify', { questions }),
      reply: async (reply) => {
        if (live.interrupted) return
        this.emit(live.sid, 'message.start', {})
        const chunks = reply.match(/.{1,12}/gs) ?? [reply]
        for (const chunk of chunks) {
          if (live.interrupted) return
          this.emit(live.sid, 'message.delta', { text: chunk })
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        if (live.interrupted) return
        this.#appendRow(stored, { role: 'assistant', text: reply })
        stored.preview ||= reply.slice(0, 80)
        this.emit(live.sid, 'message.complete', {
          text: reply,
          status: 'complete',
          usage: { input: 12, output: reply.length },
        })
      },
    }
    void (async () => {
      try {
        await this.script(context)
      } finally {
        live.running = false
        const next = live.queue.shift()
        if (next !== undefined && this.live.get(live.sid) === live) {
          this.#appendRow(stored, { role: 'user', text: next })
          this.#startTurn(live, next)
        }
      }
    })()
  }

  // --- dispatch ---------------------------------------------------------------

  async #receive(connection: FakeConnection, text: string): Promise<void> {
    if (this.frozen) return
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      connection.send(err(null, -32700, 'parse error'))
      return
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return
    const record = frame as Json
    if (
      !('method' in record) &&
      'id' in record &&
      ('result' in record || 'error' in record)
    ) {
      this.#resolveResponse(record, connection)
      return
    }
    const method = typeof record.method === 'string' ? record.method : ''
    const id = record.id
    const params = (
      typeof record.params === 'object' && record.params !== null ? record.params : {}
    ) as Json
    this.#calls.push({ kind: 'rpc', name: method })
    if (method === 'gateway.ping') {
      connection.send(ok(id, { ok: true }))
      return
    }
    const canonical = this.sessionAuthority
    const known = canonical
      ? ['client.capabilities', 'ping', 'runtime.describe'].includes(method)
      : method in this.#handlers
    if (!known) {
      connection.send(err(id, -32601, `unknown method: ${method}`))
      return
    }
    const check = this.#contract.methodParams(
      method,
      params,
      canonical && this.#contract.has('canonicalMethods', method),
    )
    if (!check.ok) {
      if (check.unknownKeysOnly) {
        connection.send(
          err(
            id,
            4000,
            `invalid params for ${method}: extra keys — the client and the Hermes backend are out of sync (different versions); run \`hermes update\` and restart both`,
          ),
        )
        return
      }
      this.#violations.push(...check.errors.map((e) => `client params ${e}`))
    }
    if (this.beforeHandle) await this.beforeHandle(method, params)
    if (!connection.open) return
    const refused = this.respondError?.(method, params)
    if (refused) {
      connection.send(err(id, refused.code, refused.message))
      return
    }
    const fail = this.failNext.get(method)
    if (fail) this.failNext.delete(method)
    if (fail === 'error-5000') {
      connection.send(err(id, 5000, `${method} failed (fixture)`))
      return
    }
    if (fail === 'unknown-method') {
      connection.send(err(id, -32601, `unknown method: ${method}`))
      return
    }
    if (fail === 'params-out-of-sync') {
      connection.send(
        err(id, 4000, `invalid params for ${method}: out of sync (fixture)`),
      )
      return
    }
    if (fail === 'no-response') return
    const handler = this.#handlers[method] as Handler
    const reply = await handler(connection, params, id)
    this.afterHandle?.(method, params)
    if (fail === 'drop-before-response') {
      connection.socket.terminate()
      return
    }
    if (reply) {
      if ('result' in reply) this.#checkResult(method, reply.result)
      connection.send(reply)
    }
    if (fail === 'drop-after-response') connection.socket.terminate()
  }

  #live(params: Json): LiveSession | undefined {
    return this.live.get(str(params.session_id))
  }

  #snapshot(live: LiveSession, includeMessages: boolean): Json {
    const stored = this.#store.sessions.get(live.storedId)
    const rows = stored?.rows ?? []
    return {
      session_id: live.sid,
      stored_session_id: live.storedId,
      message_count: rows.length,
      messages: includeMessages ? rows.map((row) => ({ ...row })) : [],
      info: {
        title: stored?.title ?? live.pendingTitle ?? '',
        running: live.running,
        stored_session_id: live.storedId,
        version: '0.22.5',
        desktop_contract: 8,
      },
      running: live.running,
      status: live.running ? 'streaming' : 'idle',
      inflight: null,
      resumed: live.storedId,
      session_key: live.storedId,
      open_requests: this.#openRequestsFor(live.sid),
    }
  }

  #attachLive(live: LiveSession, connection: FakeConnection): void {
    clearTimeout(live.reapTimer)
    live.connections.add(connection)
  }

  readonly #handlers: Record<string, Handler> = {
    'client.capabilities': (connection, params, id) => {
      this.advertisements.push(structuredClone(params))
      if ('server_requests' in params)
        connection.answersRequests = Boolean(params.server_requests)
      return ok(id, {
        server_requests: [...SERVER_REQUEST_METHODS],
        declines_not_shown: true,
      })
    },
    'gateway.capabilities': (_c, _p, id) =>
      ok(id, { per_session_exclusive_submit: true }),
    ping: (_c, _p, id) => ok(id, { pong: true }),
    'runtime.describe': (_c, _p, id) =>
      ok(id, {
        instance_id: 'fixture-instance',
        profile_id: 'default',
        authority_epoch: 1,
        capabilities: ['session:create', 'session:read', 'session:submit'],
        session_create: { sources: ['desktop'], parameters: [] },
      }),
    'session.create': (connection, params, id) => {
      const key =
        typeof params.idempotency_key === 'string' ? params.idempotency_key : undefined
      const existing = key ? this.live.get(this.#idempotency.get(key) ?? '') : undefined
      if (existing) {
        this.#attachLive(existing, connection)
        return ok(id, this.#createResult(existing))
      }
      const live: LiveSession = {
        sid: hex(4),
        storedId: this.#store.newSessionId(this.#clock.now()),
        profile: typeof params.profile === 'string' ? params.profile : 'default',
        connections: new Set([connection]),
        // Contract default is false (SessionCreateParams.close_on_disconnect).
        closeOnDisconnect: params.close_on_disconnect === true,
        running: false,
        interrupted: false,
        queue: [],
        ...(typeof params.title === 'string' && params.title
          ? { pendingTitle: params.title }
          : {}),
      }
      this.live.set(live.sid, live)
      if (key) this.#idempotency.set(key, live.sid)
      return ok(id, this.#createResult(live))
    },
    'session.list': (_c, params, id) => {
      const limit = typeof params.limit === 'number' ? params.limit : 200
      const rows = [...this.#store.sessions.values()]
        .filter((s) => !s.archived)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map((s) => ({
          id: s.id,
          title: s.title,
          preview: s.preview,
          started_at: s.startedAt,
          message_count: s.rows.length,
          source: s.source,
        }))
      return ok(id, { sessions: rows })
    },
    'session.active_list': (_c, _p, id) =>
      ok(id, {
        sessions: [...this.live.values()].map((live) => ({
          current: false,
          id: live.sid,
          last_active: this.#clock.now() / 1000,
          message_count: this.#store.sessions.get(live.storedId)?.rows.length ?? 0,
          model: 'fixture-model',
          preview: '',
          session_key: live.storedId,
          started_at: this.#clock.now() / 1000,
          status: live.running ? 'streaming' : 'idle',
          title: this.#store.sessions.get(live.storedId)?.title ?? '',
        })),
      }),
    'session.resume': (connection, params, id) => {
      const target = str(params.session_id)
      if (!target) return err(id, 4006, 'session_id required')
      const stored = this.#store.sessions.get(target)
      let live = [...this.live.values()].find((l) => l.storedId === target)
      if (!live) {
        if (!stored) return err(id, 4007, 'session not found')
        live = {
          sid: hex(4),
          storedId: target,
          profile: stored.profile,
          connections: new Set([connection]),
          closeOnDisconnect: params.close_on_disconnect === true,
          running: false,
          interrupted: false,
          queue: [],
        }
        this.live.set(live.sid, live)
      }
      this.#attachLive(live, connection)
      return ok(id, this.#snapshot(live, params.omit_messages !== true))
    },
    'session.activate': (connection, params, id) => {
      const live = this.#live(params)
      if (!live) return err(id, 4001, 'session not found')
      this.#attachLive(live, connection)
      return ok(id, this.#snapshot(live, params.omit_messages !== true))
    },
    'session.history': (_c, params, id) => {
      const live = this.#live(params)
      if (!live) return err(id, 4001, 'session not found')
      const rows = this.#store.sessions.get(live.storedId)?.rows ?? []
      return ok(id, { count: rows.length, messages: rows.map((row) => ({ ...row })) })
    },
    'session.title': (_c, params, id) => {
      const live = this.#live(params)
      if (!live) return err(id, 4001, 'session not found')
      const stored = this.#store.sessions.get(live.storedId)
      if (!('title' in params))
        return ok(id, { title: stored?.title ?? '', session_key: live.storedId })
      const title = str(params.title).trim()
      if (!title) return err(id, 4021, 'title required')
      if (stored) stored.title = title
      else live.pendingTitle = title
      return ok(id, { title, pending: !stored })
    },
    'session.interrupt': (_c, params, id) => {
      const live = this.#live(params)
      if (!live) return err(id, 4001, 'session not found')
      if (!live.running) return ok(id, { status: 'not_interrupted' })
      live.interrupted = true
      this.cancelRequests(live.sid, 'interrupted')
      this.emit(live.sid, 'message.complete', { text: '', status: 'interrupted' })
      return ok(id, { status: 'interrupted', interrupted: true })
    },
    'session.steer': (_c, params, id) => {
      const live = this.#live(params)
      if (!live) return err(id, 4001, 'session not found')
      return ok(id, {
        status: live.running ? 'queued' : 'rejected',
        text: str(params.text),
      })
    },
    'session.events.since': (_c, params, id) => {
      const sid = str(params.session_id)
      const lastSeen = typeof params.last_seen === 'number' ? params.last_seen : 0
      const events = (this.#rings.get(sid) ?? [])
        .filter((entry) => entry.seq > lastSeen)
        .map((entry) => structuredClone(entry.params))
      for (const event of events) {
        const check = this.#contract.notification(String(event.type), event.payload)
        if (!check.ok) this.#violations.push(...check.errors)
      }
      return ok(id, {
        events,
        latest_seq: this.#nextSeq.get(sid) ?? 0,
        truncated: lastSeen < (this.#evictedThrough.get(sid) ?? 0),
        count: events.length,
        epoch: this.epoch,
        open_requests: this.#openRequestsFor(sid),
      })
    },
    'session.close': (_c, params, id) => {
      const live = this.#live(params)
      if (!live) return ok(id, { closed: false })
      live.connections.clear()
      this.#reap(live.sid, 'session closed')
      return ok(id, { closed: true })
    },
    'session.most_recent': (_c, _p, id) => {
      const latest = [...this.#store.sessions.values()].sort(
        (a, b) => b.startedAt - a.startedAt,
      )[0]
      return ok(
        id,
        latest
          ? {
              session_id: latest.id,
              title: latest.title,
              started_at: latest.startedAt,
              source: latest.source,
            }
          : { session_id: null },
      )
    },
    'prompt.submit': (_c, params, id) => {
      const live = this.#live(params)
      if (!live) return err(id, 4001, 'session not found')
      const text = typeof params.text === 'string' ? params.text : ''
      if (!text.trim()) return err(id, 4002, 'text required')
      const stored = this.#storedFor(live)
      if (live.running) {
        // server.py:382-384 + session_auto_continue.py:400-406: `queued` forces queue mode;
        // otherwise the default busy_input_mode `interrupt` redirects the running turn.
        if (params.queued === true) {
          live.queue.push(text)
          return ok(id, { status: 'queued' })
        }
        live.interrupted = true
        this.cancelRequests(live.sid, 'interrupted')
        this.emit(live.sid, 'message.complete', { text: '', status: 'interrupted' })
        live.queue.unshift(text)
        return ok(id, { status: 'redirected' })
      }
      const rowId = this.#appendRow(stored, { role: 'user', text })
      stored.preview ||= text.slice(0, 80)
      setImmediate(() => this.#startTurn(live, text))
      return ok(id, { status: 'streaming', user_row_id: rowId })
    },
    'approval.pending': (_c, params, id) =>
      ok(id, {
        approvals: [...this.open.values()]
          .filter((r) => r.sid === params.session_id && r.method === 'approval')
          .map((r) => ({ ...r.params })),
      }),
    // tui_gateway/methods_prompt.py:1289-1302: settle like a response frame (no transport, so
    // never a 4404 vote) and say whether anything was still waiting.
    'request.answer': (_c, params, id) => {
      const requestId = str(params.id)
      const result = params.result
      if (!requestId || !result || typeof result !== 'object' || Array.isArray(result))
        return err(id, 4002, 'id and an object result required')
      if (!this.open.has(requestId)) {
        this.droppedResponses.push(requestId)
        return ok(id, { status: 'expired' })
      }
      this.#resolveResponse({ id: requestId, result }, undefined)
      return ok(id, { status: 'ok' })
    },
    'subagent.list': (_c, _p, id) => ok(id, { subagents: [] }),
    'process.list': (_c, _p, id) => ok(id, { processes: [] }),
    'cron.manage': (_c, params, id) => this.#cron(params, id),
    'skills.manage': (_c, _p, id) =>
      ok(id, { skills: { productivity: ['fixture-notes'] } }),
    'mcp.servers.status': (_c, _p, id) =>
      ok(id, {
        servers: this.#store.mcp.map((server) => ({ ...server })),
        checked_at: Math.floor(this.#clock.now() / 1000),
      }),
    'profiles.list': (_c, _p, id) =>
      ok(id, {
        profiles: [...this.#store.profiles.keys()].map((name) => ({
          name,
          path: `/srv/hermes-fixture/profiles/${name}`,
          is_default: name === 'default',
        })),
      }),
    'profiles.describe': (_c, params, id) =>
      ok(id, {
        name: typeof params.name === 'string' ? params.name : 'default',
        model: { provider: 'fixture', default: 'fixture-model' },
      }),
    'display.status': (_c, _p, id) => ok(id, this.#displaySnapshot()),
    'display.observe': (connection, params, id) => {
      if (!this.#store.display.running)
        return err(
          id,
          5300,
          "this profile's Bot Desktop is not running; call display.start first",
        )
      const requested = typeof params.viewer_id === 'string' ? params.viewer_id : ''
      const viewerId = connection.viewerIds.has(requested) ? requested : hex(12)
      connection.viewerIds.add(viewerId)
      const ticket = this.#auth.mintTicket({
        userId: `display:${viewerId}`,
        provider: 'bot-desktop',
        viewerId,
      })
      return ok(id, {
        ...this.#displaySnapshot(),
        ticket,
        path: '/api/display/ws',
        viewer_id: viewerId,
      })
    },
    'display.lease.acquire': (connection, params, id) => {
      const viewerId = str(params.viewer_id).trim()
      if (!viewerId) return err(id, 5300, 'viewer_id required')
      if (!connection.viewerIds.has(viewerId))
        return err(
          id,
          5300,
          'viewer_id was not minted for this connection; call display.observe first',
          { code: 'viewer_mismatch' },
        )
      const display = this.#store.display
      display.holder = 'human'
      display.holderViewerId = viewerId
      display.since = this.#clock.now() / 1000
      display.epoch += 1
      this.broadcast('display.lease', {
        profile_key: 'fixture-profile',
        lease: this.#lease(),
      })
      this.#leaseChanged()
      return ok(id, { lease: this.#lease() })
    },
    'display.lease.release': (connection, params, id) => {
      const viewerId = typeof params.viewer_id === 'string' ? params.viewer_id.trim() : ''
      const force = params.force === true
      const display = this.#store.display
      if (viewerId && !force && !connection.viewerIds.has(viewerId))
        return err(
          id,
          5300,
          'viewer_id was not minted for this connection; call display.observe first',
          { code: 'viewer_mismatch' },
        )
      if (!viewerId && !force && display.holder === 'human')
        return err(
          id,
          5300,
          "viewer_id required to release another viewer's lease (or pass force: true)",
          { code: 'viewer_mismatch' },
        )
      // lease.release: a named viewer releases only its own lease, force or not;
      // force without a name releases whoever holds (lease.py:204-226).
      if (viewerId ? display.holderViewerId === viewerId : force) {
        if (display.holder === 'human') {
          display.holder = 'agent'
          display.holderViewerId = undefined
          display.since = this.#clock.now() / 1000
          display.epoch += 1
          this.broadcast('display.lease', {
            profile_key: 'fixture-profile',
            lease: this.#lease(),
          })
          this.#leaseChanged()
        }
      }
      return ok(id, { lease: this.#lease() })
    },
  }

  #createResult(live: LiveSession): Json {
    return {
      session_id: live.sid,
      stored_session_id: live.storedId,
      message_count: 0,
      messages: [],
      info: {
        title: live.pendingTitle ?? '',
        running: false,
        stored_session_id: live.storedId,
        lazy: true,
        desktop_contract: 8,
      },
    }
  }

  #lease(): Json {
    const display = this.#store.display
    return {
      holder: display.holder,
      viewer_id: null,
      viewer_hash: display.holderViewerId
        ? createHash('sha256').update(display.holderViewerId).digest('hex').slice(0, 12)
        : null,
      since: display.since,
      epoch: display.epoch,
      reason: '',
    }
  }

  #displaySnapshot(): Json {
    const display = this.#store.display
    return {
      // The served profile's name (runtime.py:641-646); `custom` for a home outside profiles/.
      profile: this.#store.served,
      supported: display.supported,
      installed: display.installed,
      missing: display.installed ? [] : ['Xvnc'],
      running: display.running,
      // The synthetic screen behind /api/display/ws (scenario/screen.ts).
      geometry: '640x400',
      lease: this.#lease(),
      profile_key: 'fixture-profile',
    }
  }

  #cron(params: Json, id: unknown): Json {
    const action = str(params.action, 'list')
    const jobs = this.#store.cron
    const truthy = (value: unknown) =>
      value === true ||
      (typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value))
    if (action === 'list') {
      const visible = jobs.filter((job) => job.enabled || truthy(params.include_disabled))
      return ok(id, {
        success: true,
        count: visible.length,
        jobs: visible.map((job) => ({ ...job })),
      })
    }
    if (action === 'pause' || action === 'resume') {
      const job = jobs.find((j) => j.job_id === params.name || j.name === params.name)
      if (!job)
        return ok(id, { success: false, error: `Job '${String(params.name)}' not found` })
      job.enabled = action === 'resume'
      job.state = job.enabled ? 'scheduled' : 'paused'
      this.broadcast('cron.changed', {})
      return ok(id, { success: true, job: { ...job } })
    }
    return err(id, 4016, `unknown cron action: ${action}`)
  }
}

type Handler = (
  connection: FakeConnection,
  params: Json,
  id: unknown,
) => Json | undefined | Promise<Json | undefined>
