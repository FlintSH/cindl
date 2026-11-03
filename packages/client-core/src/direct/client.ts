import {
  capabilityUsable,
  CindlError,
  clientOps,
  HermesOrigin,
  parseOpArgs,
  ProfileName,
  type CapabilityId,
  type CapabilityMap,
  type CindlClientApi,
  type CindlEvent,
  type Conversation,
  type DisplayState,
  type LinkPhase,
  type LinkState,
  type OpArgs,
  type OpName,
  type OpResult,
  type PendingPrompt,
  type ServerRequest,
  type VersionedDocument,
} from '@cindl/contracts'
import {
  answerResult,
  asCindlError,
  conversationFromRow,
  createDiagnostics,
  displayState,
  EventNormalizer,
  HermesConnection,
  isBaselineVersion,
  mapServerRequest,
  mcpFromStatus,
  memoryOverviewFrom,
  NativeAuth,
  negotiateCapabilities,
  NotSentError,
  RestClient,
  routineFromJob,
  safeText,
  skillFromRow,
  transcriptToHistory,
  unsupportedReasons,
  wire,
  type ConnectionState,
  type CryptoProvider,
  type DiagnosticSink,
  type Diagnostics,
  type FetchLike,
  type Handshake,
  type HermesEventParams,
  type InboundServerRequest,
  type NormalizerEffect,
  type SecretVault,
  type SocketFactory,
  type Timers,
  type UnhandledServerRequest,
} from '@cindl/hermes-adapter'
import type {
  Clock,
  KeyValueStore,
  LoopbackAuthorizer,
  SecretStore,
  WebSocketFactory,
} from '../platform.ts'
import { sha256Hex } from '../sha256.ts'
import { DirectStorage, type AnsweredEntry } from './storage.ts'

/** Compile-time proof that client-core's platform types satisfy the adapter's structural ones. */
type Assignable<T extends U, U> = T
export type PlatformTypesMatch = [
  Assignable<WebSocketFactory, SocketFactory>,
  Assignable<Clock, Timers>,
  Assignable<SecretStore, SecretVault>,
]

export interface DirectClientDeps {
  /** The `hermes serve` origin, when the platform already knows it. */
  origin?: string
  /** `same-origin-cookie` on the web; `native-pkce` in Electron main and on Android. */
  auth: 'same-origin-cookie' | 'native-pkce'
  fetch: FetchLike
  socketFactory: WebSocketFactory
  clock: Clock
  /** Non-secret device storage: outbox, answered ledger, epoch counter, main pin. */
  kv: KeyValueStore
  /** Native only: OS-backed token storage. */
  secrets?: SecretStore
  /** Native only: randomness and SHA-256 for PKCE. */
  crypto?: CryptoProvider
  /** Native only: the system-browser + loopback leg of sign-in. */
  authorizer?: LoopbackAuthorizer
  /** Hermes profile for SOUL.md. Default `default`. */
  profile?: string
  /** Redacted diagnostics. */
  log?: DiagnosticSink
  /** Jitter source in [0, 1). */
  random?: () => number
  connection?: {
    requestTimeoutMs?: number
    heartbeatIntervalMs?: number
    heartbeatDeadlineMs?: number
    backoff?: { initialMs: number; maxMs: number }
  }
}

export interface DirectClient extends CindlClientApi {
  /** Load device state, discover Hermes and connect when signed in. */
  start(): Promise<void>
  /** Close the connection. Device state stays. */
  stop(): void
}

type Handler<K extends OpName> = (args: OpArgs<K>) => Promise<OpResult<K>> | OpResult<K>

interface TrackedRequest {
  request: ServerRequest
  runtimeSessionId: string
}

const LOOPBACK_MODE =
  'Hermes is running in loopback-token mode. Cindl needs a sign-in provider (password or OAuth) and never reads the per-process dashboard token.'

/**
 * The direct Hermes client (overview: data flow). It implements every
 * `CindlClientApi` operation on top of `@cindl/hermes-adapter` and emits the
 * CindlEvents each result implies, so every store fed by `subscribe`
 * converges. Platform-agnostic: storage, sockets, clocks, crypto and the
 * browser leg come in through `DirectClientDeps`.
 */
export function createDirectClient(deps: DirectClientDeps): DirectClient {
  return new DirectHermesClient(deps)
}

class DirectHermesClient implements DirectClient {
  readonly #deps: DirectClientDeps
  readonly #log: Diagnostics
  readonly #listeners = new Set<(event: CindlEvent) => void>()
  #origin: string | undefined
  #storage: DirectStorage | undefined
  #rest: RestClient | undefined
  #native: NativeAuth | undefined
  #connection: HermesConnection | undefined
  #status: wire.StatusResponse | undefined
  #signedIn = false
  #everOnline = false
  #handshake: Handshake | undefined
  #epoch = 0
  #link: LinkState
  #capabilities: CapabilityMap = {}
  #capabilitiesJson = ''
  #normalizer: EventNormalizer
  readonly #conversations = new Map<string, Conversation>()
  readonly #runtime = new Map<string, string>()
  readonly #stored = new Map<string, string>()
  readonly #watermark = new Map<string, number>()
  readonly #historyLoaded = new Set<string>()
  readonly #requests = new Map<string, TrackedRequest>()
  readonly #answered = new Map<string, AnsweredEntry>()
  readonly #resent = new Set<string>()
  readonly #noticed = new Set<string>()
  readonly #prompts = new Map<string, PendingPrompt>()
  #main: string | undefined
  #holding = false
  #held: HermesEventParams[] = []
  #display: {
    status?: Pick<wire.DisplayStatus, 'supported' | 'installed' | 'running'>
    lease?: wire.DisplayLease
    viewerId?: string
    viewerEpoch?: number
    previous: Set<string>
  } = { previous: new Set() }
  #listRefresh: unknown
  #started = false
  readonly #profile: string

  constructor(deps: DirectClientDeps) {
    this.#deps = deps
    this.#log = createDiagnostics(deps.log)
    this.#link = {
      phase: 'unconfigured',
      since: this.#now(),
      connectionEpoch: 0,
      auth: deps.auth,
    }
    this.#normalizer = this.#newNormalizer()
    this.#profile = ProfileName.parse(deps.profile ?? 'default')
    if (deps.origin) this.#configure(HermesOrigin.parse(deps.origin))
  }

  // --- CindlClientApi --------------------------------------------------------

  subscribe(listener: (event: CindlEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async call<K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>> {
    const parsed = parseOpArgs(name, args)
    const capability = (clientOps[name] as { capability?: CapabilityId }).capability
    // A signed-in device that is only temporarily disconnected may queue a
    // prompt: it was never sent, so sending it after reconnect is safe.
    const queueable = name === 'prompt.submit' && this.#temporarilyOffline()
    // display.status is the read-only probe that establishes computer.view, so
    // it only needs a sidecar connection (a stopped screen is a valid answer).
    const probe = name === 'display.status' && this.#sidecarOnline()
    if (capability && !queueable && !probe) this.#require(capability)
    const handler = this.#handlers[name] as unknown as (a: typeof parsed) => unknown
    try {
      return (await handler(parsed)) as OpResult<K>
    } catch (error) {
      throw asCindlError(error, name)
    }
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    if (!this.#origin) {
      this.#setLink('unconfigured')
      return
    }
    await this.#loadDevice()
    await this.#discoverAndConnect()
  }

  stop(): void {
    this.#connection?.stop()
    this.#connection = undefined
    this.#deps.clock.clearTimeout(this.#listRefresh)
  }

  // --- setup -------------------------------------------------------------------

  #now(): string {
    return new Date(this.#deps.clock.now()).toISOString()
  }

  #id(): string {
    const random = this.#deps.crypto?.randomBytes(12)
    if (random) return [...random].map((b) => b.toString(16).padStart(2, '0')).join('')
    const r = this.#deps.random ?? Math.random
    return Array.from({ length: 24 }, () => Math.floor(r() * 16).toString(16)).join('')
  }

  #newNormalizer(): EventNormalizer {
    return new EventNormalizer({
      conversationFor: (sid) => this.#stored.get(sid),
      now: () => this.#now(),
    })
  }

  #configure(origin: string): void {
    this.#origin = origin
    this.#storage = new DirectStorage(this.#deps.kv, origin, (name) =>
      this.#log.log('warn', 'direct.storage-write-failed', { name }),
    )
    const timers: Timers = this.#deps.clock
    if (this.#deps.auth === 'native-pkce') {
      if (!this.#deps.secrets || !this.#deps.crypto)
        throw new CindlError(
          'invalid',
          'Native sign-in needs a secret store and crypto provider.',
        )
      this.#native = new NativeAuth({
        origin,
        fetch: this.#deps.fetch,
        timers,
        secrets: this.#deps.secrets,
        crypto: this.#deps.crypto,
        diagnostics: this.#log,
      })
    } else this.#native = undefined
    this.#rest = new RestClient({
      origin,
      fetch: this.#deps.fetch,
      timers,
      auth: this.#native ? this.#native.restAuth() : { kind: 'cookie' },
      diagnostics: this.#log,
    })
  }

  async #loadDevice(): Promise<void> {
    const storage = this.#storage
    if (!storage) return
    this.#epoch = await storage.loadEpoch()
    this.#main = await storage.loadMain()
    for (const entry of await storage.loadAnswered())
      this.#answered.set(entry.requestId, entry)
    let changed = false
    for (const prompt of await storage.loadOutbox()) {
      // A prompt that was being sent when the app stopped may have reached Hermes.
      const recovered: PendingPrompt =
        prompt.state === 'sending'
          ? {
              ...prompt,
              state: 'uncertain',
              error: 'The app stopped while sending; it was not resent.',
            }
          : prompt
      changed ||= recovered !== prompt
      this.#prompts.set(recovered.clientId, recovered)
      this.#emit({ type: 'prompt.updated', prompt: recovered })
    }
    if (changed) await storage.saveOutbox(this.#prompts.values())
  }

  async #discoverAndConnect(): Promise<void> {
    const rest = this.#rest
    if (!rest) return
    this.#setLink('connecting')
    try {
      this.#status = await rest.status()
    } catch (error) {
      const cause = asCindlError(error, 'discovery')
      this.#setLink(
        cause.code === 'offline' || cause.code === 'timeout' ? 'offline' : 'error',
        cause,
      )
      this.#refreshCapabilities()
      return
    }
    if (this.#status.auth_required === false) {
      this.#setLink('incompatible', new CindlError('unsupported', LOOPBACK_MODE))
      this.#refreshCapabilities()
      return
    }
    try {
      this.#signedIn = await this.#checkSignedIn()
    } catch (error) {
      const cause = asCindlError(error, 'auth.me')
      this.#setLink(
        cause.code === 'offline' || cause.code === 'timeout' ? 'offline' : 'error',
        cause,
      )
      this.#refreshCapabilities()
      return
    }
    if (!this.#signedIn) {
      this.#setLink('signed-out')
      this.#refreshCapabilities()
      return
    }
    this.#connect()
  }

  async #checkSignedIn(): Promise<boolean> {
    if (this.#native) return (await this.#native.identity()) !== undefined
    try {
      await this.#rest?.me()
      return true
    } catch (error) {
      const cause = asCindlError(error, 'auth.me')
      if (cause.code === 'unauthenticated') return false
      throw cause
    }
  }

  #connect(): void {
    const rest = this.#rest
    const origin = this.#origin
    if (!rest || !origin) return
    this.#connection?.stop()
    const options = this.#deps.connection ?? {}
    this.#connection = new HermesConnection({
      origin,
      rest,
      socketFactory: this.#deps.socketFactory,
      timers: this.#deps.clock,
      diagnostics: this.#log,
      initialEpoch: this.#epoch,
      ...(this.#deps.random ? { random: this.#deps.random } : {}),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.heartbeatDeadlineMs === undefined
        ? {}
        : { heartbeatDeadlineMs: options.heartbeatDeadlineMs }),
      ...(options.backoff ? { backoff: options.backoff } : {}),
      callbacks: {
        onReady: (handshake) => this.#onReady(handshake),
        onEvent: (params) => this.#onEvent(params),
        onServerRequest: (request, epoch) => this.#onServerRequest(request, epoch),
        onUnhandledServerRequest: (request) => this.#onUnhandledServerRequest(request),
        onState: (state) => this.#onConnectionState(state),
      },
    })
    this.#connection.start()
  }

  // --- link and capabilities ---------------------------------------------------

  #setLink(phase: LinkPhase, error?: CindlError): void {
    const version = this.#status?.version
    const next: LinkState = {
      phase,
      since: phase === this.#link.phase ? this.#link.since : this.#now(),
      connectionEpoch: this.#epoch,
      auth: this.#deps.auth,
      ...(this.#origin
        ? {
            server: {
              origin: this.#origin,
              ...(version ? { hermesVersion: version } : {}),
              ...(version && !isBaselineVersion(version)
                ? { untestedVersion: true }
                : {}),
              ...(this.#handshake
                ? {
                    authority: this.#handshake.authority,
                    sessionAuthority: this.#handshake.sessionAuthority,
                  }
                : {}),
            },
          }
        : {}),
      ...(this.#handshake ? { replayEpoch: this.#handshake.replayEpoch } : {}),
      ...(error ? { lastError: { code: error.code, message: error.message } } : {}),
    }
    if (JSON.stringify(next) === JSON.stringify(this.#link)) return
    this.#link = next
    this.#emit({ type: 'link.changed', link: next })
  }

  #refreshCapabilities(): void {
    const online = this.#link.phase === 'online' && this.#handshake
    const map = negotiateCapabilities({
      checkedAt: this.#link.since,
      signedIn: this.#signedIn,
      ...(this.#status ? { status: this.#status } : {}),
      ...(online && this.#handshake ? { handshake: this.#handshake } : {}),
      ...(online ? {} : { offlineReason: this.#offlineReason() }),
      ...(online && this.#display.status ? { display: this.#display.status } : {}),
    })
    const json = JSON.stringify(map)
    if (json === this.#capabilitiesJson) return
    this.#capabilitiesJson = json
    this.#capabilities = map
    this.#emit({ type: 'capabilities.changed', capabilities: map })
  }

  #offlineReason(): string {
    switch (this.#link.phase) {
      case 'unconfigured':
        return 'Choose a Hermes server first.'
      case 'signed-out':
        return 'Sign in to Hermes first.'
      case 'incompatible':
        return this.#link.lastError?.message ?? 'This Hermes server is not compatible.'
      default:
        return 'Not connected to Hermes right now.'
    }
  }

  #sidecarOnline(): boolean {
    return (
      this.#link.phase === 'online' && this.#handshake?.authority === 'legacy-sidecar-v8'
    )
  }

  #temporarilyOffline(): boolean {
    const phase = this.#link.phase
    return (
      this.#signedIn &&
      this.#everOnline &&
      (phase === 'offline' || phase === 'reconnecting' || phase === 'connecting')
    )
  }

  #require(capability: CapabilityId): void {
    const entry = this.#capabilities[capability]
    if (capabilityUsable(entry)) return
    const reason =
      entry?.reason ??
      (unsupportedReasons as Partial<Record<CapabilityId, string>>)[capability] ??
      this.#offlineReason()
    throw new CindlError(
      entry?.state === 'unsupported' ? 'unsupported' : 'unavailable',
      reason,
    )
  }

  #onConnectionState(state: ConnectionState): void {
    switch (state.phase) {
      case 'connecting':
        this.#setLink(this.#everOnline ? 'reconnecting' : 'connecting')
        break
      case 'online':
        this.#everOnline = true
        this.#setLink('online')
        break
      case 'reconnecting':
        this.#setLink(
          state.lastError?.code === 'offline' ? 'offline' : 'reconnecting',
          state.lastError,
        )
        break
      case 'signed-out':
        this.#signedIn = false
        this.#setLink('signed-out', state.lastError)
        break
      case 'incompatible':
        this.#setLink('incompatible', state.lastError)
        break
      case 'stopped':
        break
    }
    this.#refreshCapabilities()
  }

  // --- reconnect reconciliation ----------------------------------------------------

  async #onReady(handshake: Handshake): Promise<void> {
    const previous = this.#handshake
    this.#handshake = handshake
    this.#epoch = handshake.connectionEpoch
    void this.#storage?.saveEpoch(this.#epoch)
    if (this.#display.viewerId && this.#display.viewerEpoch !== this.#epoch) {
      // Viewer ids belong to the connection that minted them (methods_display.py).
      this.#display.previous.add(sha256Hex(this.#display.viewerId).slice(0, 12))
      delete this.#display.viewerId
      delete this.#display.viewerEpoch
    }
    if (handshake.authority !== 'legacy-sidecar-v8') return
    const epochChanged =
      previous !== undefined && handshake.previousReplayEpoch !== handshake.replayEpoch
    this.#holding = true
    const openIds = new Set<string>()
    const openEntries: wire.OpenRequestEntry[] = []
    try {
      for (const [storedId, oldSid] of [...this.#runtime]) {
        await this.#reattach(
          storedId,
          oldSid,
          epochChanged,
          handshake,
          openIds,
          openEntries,
        )
      }
    } finally {
      this.#holding = false
      const held = this.#held
      this.#held = []
      for (const params of held) this.#dispatchEvent(params)
    }
    this.#connection?.channel?.deliverOpenRequests(openEntries)
    for (const [requestId, tracked] of [...this.#requests])
      if (!openIds.has(requestId) && tracked.request.status === 'open')
        this.#requests.delete(requestId)
    this.#emit({ type: 'requests.synced', openRequestIds: [...openIds] })
    void this.#flushOutbox()
    this.#scheduleListRefresh(0)
    void this.#probeDisplay()
  }

  async #reattach(
    storedId: string,
    oldSid: string,
    epochChanged: boolean,
    handshake: Handshake,
    openIds: Set<string>,
    openEntries: wire.OpenRequestEntry[],
  ): Promise<void> {
    const collect = (entries: readonly wire.OpenRequestEntry[] | null | undefined) => {
      for (const entry of entries ?? [])
        if (!openIds.has(entry.id)) {
          openIds.add(entry.id)
          openEntries.push(entry)
        }
    }
    let snapshot: wire.SessionResumeResult
    try {
      snapshot = await this.#resume(storedId, true)
    } catch (error) {
      this.#log.log('warn', 'direct.reattach-failed', {
        code: asCindlError(error, 'resume').code,
      })
      this.#detachRuntime(storedId)
      return
    }
    collect(snapshot.open_requests)
    const newSid = snapshot.session_id
    const watermark = this.#watermark.get(oldSid)
    if (newSid === oldSid && !epochChanged && watermark !== undefined) {
      const raw = await this.#connection
        ?.request('session.events.since', { session_id: oldSid, last_seen: watermark })
        .catch(() => undefined)
      const since =
        raw === undefined ? undefined : wire.parseWire(wire.SessionEventsSinceResult, raw)
      if (since) collect(since.open_requests)
      if (!since || since.epoch !== handshake.replayEpoch || since.truncated) {
        // The replay has a hole (or none came back): reload instead of trusting it.
        if (since) this.#watermark.set(oldSid, Math.max(watermark, since.latest_seq))
        this.#resetHistory(storedId, since?.truncated ? 'truncated' : 'epoch-changed')
      } else
        for (const event of since.events)
          this.#dispatchEvent(event as unknown as HermesEventParams)
      return
    }
    // A different runtime session or a restarted Hermes: the old numbering is gone.
    this.#normalizer.forgetSession(oldSid)
    this.#watermark.delete(oldSid)
    this.#resetHistory(storedId, epochChanged ? 'epoch-changed' : 'resync')
  }

  #resetHistory(
    storedId: string,
    reason: 'epoch-changed' | 'truncated' | 'resync',
  ): void {
    if (!this.#historyLoaded.delete(storedId)) return
    this.#emit({ type: 'history.reset', conversationId: storedId, reason })
  }

  // --- events ---------------------------------------------------------------------

  #onEvent(params: HermesEventParams): void {
    if (this.#holding) {
      this.#held.push(params)
      return
    }
    this.#dispatchEvent(params)
  }

  /** Seq-gated: a replayed or duplicated frame never applies twice. */
  #dispatchEvent(params: HermesEventParams): void {
    const sid = typeof params.session_id === 'string' ? params.session_id : ''
    if (sid && typeof params.seq === 'number') {
      if (params.seq <= (this.#watermark.get(sid) ?? 0)) return
      this.#watermark.set(sid, params.seq)
    }
    const out = this.#normalizer.normalize(params)
    for (const event of out.events) this.#emit(event)
    for (const effect of out.effects) this.#applyEffect(effect)
  }

  #applyEffect(effect: NormalizerEffect): void {
    switch (effect.kind) {
      case 'title': {
        const conversation = this.#conversations.get(effect.storedId)
        if (conversation && conversation.title !== effect.title)
          this.#upsert({ ...conversation, title: effect.title })
        return
      }
      case 'sessions-changed':
        this.#scheduleListRefresh(250)
        return
      case 'request-cancelled':
        this.#closeRequest(
          effect.requestId,
          effect.reason === 'timeout' ? 'expired' : 'cancelled',
        )
        return
      case 'approvals-cancelled':
        for (const [requestId, tracked] of [...this.#requests])
          if (
            tracked.request.hermesApprovalId &&
            effect.requestIds.includes(tracked.request.hermesApprovalId)
          )
            this.#closeRequest(requestId, 'cancelled')
        return
      case 'display-status':
        this.#display.status = effect.status
        this.#display.lease = effect.status.lease
        this.#emitDisplay()
        this.#refreshCapabilities()
        return
      case 'display-lease':
        this.#display.lease = effect.lease
        this.#emitDisplay()
        return
      case 'session-reclaimed': {
        const storedId = this.#stored.get(effect.runtimeSessionId)
        if (storedId) {
          this.#detachRuntime(storedId)
          this.#resetHistory(storedId, 'resync')
        }
        return
      }
      case 'cron-changed':
      case 'skills-changed':
      case 'turn-ended':
        return
    }
  }

  #emit(event: CindlEvent): void {
    if (event.type === 'session.status') {
      const conversation = this.#conversations.get(event.conversationId)
      if (conversation && conversation.status !== event.status)
        this.#conversations.set(event.conversationId, {
          ...conversation,
          status: event.status,
        })
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#log.log('error', 'direct.listener-failed', {
          error: error instanceof Error ? error.name : 'unknown',
        })
      }
    }
  }

  // --- conversations ----------------------------------------------------------------

  #upsert(conversation: Conversation): Conversation {
    this.#conversations.set(conversation.id, conversation)
    this.#emit({ type: 'conversation.upserted', conversation })
    return conversation
  }

  #bindRuntime(storedId: string, sid: string): void {
    const old = this.#runtime.get(storedId)
    if (old && old !== sid) this.#stored.delete(old)
    this.#runtime.set(storedId, sid)
    this.#stored.set(sid, storedId)
    const conversation = this.#conversations.get(storedId)
    if (conversation && conversation.session.runtimeId !== sid)
      this.#upsert({ ...conversation, session: { storedId, runtimeId: sid } })
  }

  #detachRuntime(storedId: string): void {
    const sid = this.#runtime.get(storedId)
    if (!sid) return
    this.#runtime.delete(storedId)
    this.#stored.delete(sid)
    this.#watermark.delete(sid)
    this.#normalizer.forgetSession(sid)
    const conversation = this.#conversations.get(storedId)
    if (conversation)
      this.#upsert({ ...conversation, session: { storedId }, status: 'unknown' })
  }

  async #resume(
    storedId: string,
    omitMessages: boolean,
  ): Promise<wire.SessionResumeResult> {
    const raw = await this.#rpc('session.resume', {
      session_id: storedId,
      ...(omitMessages ? { omit_messages: true } : {}),
    })
    const snapshot = wire.parseWire(wire.SessionResumeResult, raw)
    if (!snapshot)
      throw new CindlError(
        'protocol',
        'Hermes answered in an unexpected format.',
        'session.resume',
      )
    this.#bindRuntime(storedId, snapshot.session_id)
    if (snapshot.running) {
      const conversation = this.#conversations.get(storedId)
      if (conversation)
        this.#emit({
          type: 'session.status',
          conversationId: storedId,
          status: 'working',
        })
    }
    return snapshot
  }

  /** The runtime id of a stored session, attaching it to this socket when needed. */
  async #attach(storedId: string): Promise<string> {
    const known = this.#runtime.get(storedId)
    if (known) return known
    const snapshot = await this.#resume(storedId, true)
    this.#connection?.channel?.deliverOpenRequests(snapshot.open_requests ?? [])
    return snapshot.session_id
  }

  #conversationOrThrow(conversationId: string): Conversation {
    const conversation = this.#conversations.get(conversationId)
    if (!conversation)
      throw new CindlError('not-found', 'That conversation is not known on this device.')
    return conversation
  }

  #scheduleListRefresh(ms: number): void {
    this.#deps.clock.clearTimeout(this.#listRefresh)
    this.#listRefresh = this.#deps.clock.setTimeout(() => {
      this.#listConversations().catch(() => undefined)
    }, ms)
  }

  async #listConversations(): Promise<Conversation[]> {
    const raw = await this.#rpc('session.list', { limit: 200 })
    const result = wire.parseWire(wire.SessionListResult, raw)
    if (!result)
      throw new CindlError(
        'protocol',
        'Hermes answered in an unexpected format.',
        'session.list',
      )
    const seen = new Set<string>()
    const conversations = result.sessions.map((row) => {
      seen.add(row.id)
      const runtimeId = this.#runtime.get(row.id)
      const existing = this.#conversations.get(row.id)
      const mapped = conversationFromRow(row, {
        kind: row.id === this.#main ? 'main' : 'side',
        ...(runtimeId ? { runtimeId } : {}),
      })
      return this.#upsert({ ...mapped, status: existing?.status ?? mapped.status })
    })
    // Rows can vanish (deleted, archived elsewhere); keep the ones live on this socket.
    for (const id of [...this.#conversations.keys()])
      if (!seen.has(id) && !this.#runtime.has(id)) {
        this.#conversations.delete(id)
        this.#emit({ type: 'conversation.removed', conversationId: id })
      }
    return conversations
  }

  // --- RPC helpers ----------------------------------------------------------------------

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = this.#connection
    if (!connection)
      throw new CindlError(
        'offline',
        'Not connected to Hermes.',
        `${method}: no connection`,
      )
    return connection.request(method, params)
  }

  #restOrThrow(): RestClient {
    if (!this.#rest) throw new CindlError('unavailable', 'Choose a Hermes server first.')
    return this.#rest
  }

  // --- server requests ----------------------------------------------------------------

  #onServerRequest(inbound: InboundServerRequest, epoch: number): void {
    const answered = this.#answered.get(inbound.id)
    if (answered) {
      // Hermes still lists a request this device answered, so the reply never
      // arrived. Re-send the same decision; the first reply wins, so this is safe.
      const key = `${inbound.id}|${epoch}`
      if (!this.#resent.has(key)) {
        this.#resent.add(key)
        inbound.respond(answered.result)
        this.#log.log('info', 'direct.request-reply-resent', { epoch })
      }
      return
    }
    const sid =
      typeof inbound.params.session_id === 'string' ? inbound.params.session_id : ''
    const conversationId = this.#stored.get(sid)
    const existing = this.#requests.get(inbound.id)
    const mapped = mapServerRequest({
      requestId: inbound.id,
      method: inbound.method,
      params: inbound.params,
      lastSeenEpoch: epoch,
      receivedAt: existing?.request.receivedAt ?? this.#now(),
      ...(conversationId ? { conversationId } : {}),
    })
    // A frame Cindl cannot read stays open for clients that can.
    if (!mapped) {
      this.#log.log('warn', 'direct.request-unreadable', { method: inbound.method })
      return
    }
    this.#requests.set(inbound.id, {
      request: mapped.request,
      runtimeSessionId: mapped.runtimeSessionId,
    })
    this.#emit({ type: 'request.opened', request: mapped.request })
    if (conversationId)
      this.#emit({ type: 'session.status', conversationId, status: 'waiting-on-you' })
  }

  #onUnhandledServerRequest(request: UnhandledServerRequest): void {
    if (request.action !== 'leave-open' || this.#noticed.has(request.id)) return
    this.#noticed.add(request.id)
    this.#emit({
      type: 'notice',
      level: 'warning',
      message: `Hermes is waiting for input Cindl does not handle (${safeText(request.method, 40)}). Answer it where Hermes asked, or it times out.`,
    })
  }

  #closeRequest(
    requestId: string,
    status: 'answered' | 'resolved-elsewhere' | 'cancelled' | 'expired' | 'failed',
  ): void {
    if (!this.#requests.delete(requestId)) return
    this.#emit({ type: 'request.closed', requestId, status })
  }

  // --- prompts ------------------------------------------------------------------------

  #setPrompt(prompt: PendingPrompt): PendingPrompt {
    this.#prompts.set(prompt.clientId, prompt)
    this.#emit({ type: 'prompt.updated', prompt })
    void this.#storage?.saveOutbox(this.#prompts.values())
    return prompt
  }

  async #send(prompt: PendingPrompt): Promise<PendingPrompt> {
    const sending = this.#setPrompt({ ...prompt, state: 'sending' })
    let sid: string
    try {
      sid = await this.#attach(prompt.conversationId)
    } catch (error) {
      const cause = asCindlError(error, 'attach')
      return this.#setPrompt(
        cause.code === 'offline' || cause.code === 'timeout'
          ? { ...prompt, state: 'queued-offline' }
          : { ...prompt, state: 'failed', error: cause.message },
      )
    }
    let raw: unknown
    try {
      raw = await this.#rpc('prompt.submit', { session_id: sid, text: prompt.text })
    } catch (error) {
      if (error instanceof NotSentError)
        return this.#setPrompt({ ...prompt, state: 'queued-offline' })
      const cause = asCindlError(error, 'prompt.submit')
      // A timeout or a drop after sending: Hermes may have run it. Never resent.
      if (cause.code === 'offline' || cause.code === 'timeout')
        return this.#setPrompt({
          ...prompt,
          state: 'uncertain',
          error:
            'The connection dropped before Hermes confirmed this message. It was not resent.',
        })
      return this.#setPrompt({ ...prompt, state: 'failed', error: cause.message })
    }
    const result = wire.parseWire(wire.PromptSubmitResult, raw)
    const accepted = this.#setPrompt({
      ...sending,
      state: 'accepted',
      ...(result?.status ? { disposition: result.status } : {}),
    })
    const messageId = `prompt:${prompt.clientId}`
    this.#emit({
      type: 'message.started',
      conversationId: prompt.conversationId,
      messageId,
      role: 'user',
    })
    this.#emit({
      type: 'message.completed',
      conversationId: prompt.conversationId,
      messageId,
      status: 'complete',
      text: prompt.text,
    })
    return accepted
  }

  async #flushOutbox(): Promise<void> {
    const queued = [...this.#prompts.values()]
      .filter((p) => p.state === 'queued-offline')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const prompt of queued) {
      if (!this.#connection?.channel) return
      await this.#send(prompt)
    }
  }

  // --- documents ----------------------------------------------------------------------

  #document(key: string, content: string, source: string): VersionedDocument {
    return { key, content, version: sha256Hex(content), readAt: this.#now(), source }
  }

  async #readSoul(profile: string): Promise<VersionedDocument> {
    const soul = await this.#restOrThrow().soul(profile)
    return this.#document(
      `soul:${profile}`,
      soul.content,
      `GET /api/profiles/${profile}/soul`,
    )
  }

  async #readSkill(name: string): Promise<VersionedDocument> {
    const skill = await this.#restOrThrow().skillContent(name)
    return this.#document(`skill:${name}`, skill.content, 'GET /api/skills/content')
  }

  // --- display ------------------------------------------------------------------------

  #displayState(): DisplayState {
    const viewer = this.#display.viewerId
    return displayState(
      this.#display.status,
      this.#display.lease,
      {
        current: viewer ? sha256Hex(viewer).slice(0, 12) : undefined,
        previous: this.#display.previous,
      },
      this.#now(),
    )
  }

  #emitDisplay(): DisplayState {
    const display = this.#displayState()
    this.#emit({ type: 'display.changed', display })
    return display
  }

  async #probeDisplay(): Promise<void> {
    try {
      await this.#readDisplay()
    } catch {
      // Unknown stays unknown: computer.* is left out of the capability map.
    }
  }

  async #readDisplay(): Promise<DisplayState> {
    const status = wire.parseWire(
      wire.DisplayStatus,
      await this.#rpc('display.status', {}),
    )
    if (!status)
      throw new CindlError(
        'protocol',
        'Hermes answered in an unexpected format.',
        'display.status',
      )
    this.#display.status = status
    this.#display.lease = status.lease
    this.#refreshCapabilities()
    return this.#emitDisplay()
  }

  // --- operations -----------------------------------------------------------------------

  readonly #handlers: { [K in OpName]: Handler<K> } = {
    'link.get': () => this.#link,
    'capabilities.get': () => this.#capabilities,
    'auth.signIn': async ({ origin }) => {
      if (origin !== this.#origin) {
        this.stop()
        this.#reset()
        this.#configure(origin)
        await this.#loadDevice()
      }
      const rest = this.#restOrThrow()
      this.#setLink('connecting')
      this.#status = await rest.status()
      if (this.#status.auth_required === false) {
        const error = new CindlError('unsupported', LOOPBACK_MODE)
        this.#setLink('incompatible', error)
        this.#refreshCapabilities()
        throw error
      }
      if (this.#native) {
        if (!(this.#status.auth_flows ?? []).includes('native_pkce')) {
          const error = new CindlError(
            'unsupported',
            'This Hermes server does not offer native sign-in (auth_flows has no native_pkce).',
          )
          this.#setLink('signed-out', error)
          throw error
        }
        if (!(await this.#native.identity())) {
          if (!this.#deps.authorizer)
            throw new CindlError(
              'unavailable',
              'This device cannot open the Hermes sign-in page.',
            )
          await this.#native.signIn(this.#deps.authorizer)
        }
      } else if (!(await this.#checkSignedIn())) {
        const error = new CindlError(
          'unauthenticated',
          'Sign in on the Hermes login page, then try again.',
        )
        this.#setLink('signed-out', error)
        throw error
      }
      this.#signedIn = true
      this.#connect()
      return this.#link
    },
    'auth.signOut': async () => {
      this.stop()
      await this.#native?.signOut()
      this.#signedIn = false
      this.#handshake = undefined
      for (const requestId of [...this.#requests.keys()])
        this.#closeRequest(requestId, 'cancelled')
      this.#setLink('signed-out')
      this.#refreshCapabilities()
      return { localOnly: true as const }
    },
    'conversations.list': () => this.#listConversations(),
    'conversations.create': async ({ title }) => {
      const raw = await this.#rpc('session.create', {
        ...(title?.trim() ? { title: title.trim() } : {}),
        close_on_disconnect: false,
        idempotency_key: this.#id(),
      })
      const created = wire.parseWire(wire.SessionCreateResult, raw)
      if (!created)
        throw new CindlError(
          'protocol',
          'Hermes answered in an unexpected format.',
          'session.create',
        )
      const now = this.#now()
      const conversation = this.#upsert({
        id: created.stored_session_id,
        session: { storedId: created.stored_session_id, runtimeId: created.session_id },
        title: title?.trim() || 'New conversation',
        kind: 'side',
        createdAt: now,
        updatedAt: now,
        status: 'idle',
      })
      this.#bindRuntime(conversation.id, created.session_id)
      this.#historyLoaded.add(conversation.id)
      this.#emit({
        type: 'history.loaded',
        conversationId: conversation.id,
        messages: [],
      })
      return conversation
    },
    'conversations.setMain': async ({ conversationId }) => {
      const target = this.#conversationOrThrow(conversationId)
      this.#main = conversationId
      await this.#storage?.saveMain(conversationId)
      for (const conversation of [...this.#conversations.values()])
        if (conversation.kind === 'main' && conversation.id !== conversationId)
          this.#upsert({ ...conversation, kind: 'side' })
      return this.#upsert({ ...target, kind: 'main' })
    },
    'conversations.rename': async ({ conversationId, title }) => {
      const conversation = this.#conversationOrThrow(conversationId)
      const rest = this.#restOrThrow()
      for (let attempt = 0; ; attempt++) {
        const snapshot = await rest.mutationSnapshot(conversationId)
        if (!snapshot.exists) {
          // No stored row yet (no prompt sent): Hermes queues the title on the live session.
          const sid = this.#runtime.get(conversationId)
          if (!sid)
            throw new CindlError(
              'not-found',
              'Hermes has no record of that conversation yet.',
            )
          await this.#rpc('session.title', { session_id: sid, title })
          break
        }
        try {
          await rest.patchSession(conversationId, {
            request_id: this.#id(),
            expected_revision: snapshot.runtime_revision,
            ...(snapshot.runtime_generation == null
              ? {}
              : { expected_generation: snapshot.runtime_generation }),
            title,
          })
          break
        } catch (error) {
          const cause = asCindlError(error, 'rename')
          // A rename is a "set": one retry on a fresh revision is safe; the
          // refused write was not applied.
          if (
            cause.code === 'conflict' &&
            /revision_conflict/.test(cause.detail ?? '') &&
            attempt === 0
          )
            continue
          throw cause
        }
      }
      return this.#upsert({ ...conversation, title, updatedAt: this.#now() })
    },
    'conversations.history': async ({ conversationId }) => {
      const snapshot = await this.#resume(conversationId, false)
      this.#connection?.channel?.deliverOpenRequests(snapshot.open_requests ?? [])
      const history = transcriptToHistory(conversationId, snapshot.messages)
      for (const activity of history.tools) this.#emit({ type: 'tool.updated', activity })
      this.#historyLoaded.add(conversationId)
      this.#emit({ type: 'history.loaded', conversationId, messages: history.messages })
      return history
    },
    'prompt.submit': async ({ conversationId, clientId, text }) => {
      const existing = this.#prompts.get(clientId)
      // Never send the same client prompt twice.
      if (existing) return existing
      this.#conversationOrThrow(conversationId)
      const prompt: PendingPrompt = {
        clientId,
        conversationId,
        text,
        createdAt: this.#now(),
        state: 'queued-offline',
      }
      if (!this.#connection?.channel) return this.#setPrompt(prompt)
      return this.#send(prompt)
    },
    'prompt.discard': async ({ clientId }) => {
      const prompt = this.#prompts.get(clientId)
      if (!prompt || prompt.state === 'accepted' || prompt.state === 'sending')
        return { discarded: false }
      this.#prompts.delete(clientId)
      await this.#storage?.saveOutbox(this.#prompts.values())
      return { discarded: true }
    },
    'conversation.interrupt': async ({ conversationId }) => {
      this.#conversationOrThrow(conversationId)
      const sid = await this.#attach(conversationId)
      await this.#rpc('session.interrupt', { session_id: sid })
      return { requested: true as const }
    },
    'request.answer': async ({ requestId, answer }) => {
      const tracked = this.#requests.get(requestId)
      if (!tracked) throw new CindlError('not-found', 'This request is no longer open.')
      if (this.#answered.has(requestId) || tracked.request.status !== 'open')
        throw new CindlError(
          'conflict',
          'This request was already answered on this device.',
        )
      this.#require(
        tracked.request.kind === 'approval' ? 'requests.approval' : 'requests.clarify',
      )
      const result = answerResult(tracked.request, answer)
      const channel = this.#connection?.channel
      if (!channel)
        throw new CindlError('offline', 'Not connected to Hermes.', 'request.answer')
      // Recorded before sending: a crash after sending must never allow a second answer.
      const entry: AnsweredEntry = {
        requestId,
        result,
        answeredAt: this.#now(),
        epoch: this.#epoch,
      }
      this.#answered.set(requestId, entry)
      await this.#storage?.saveAnswered(this.#answered.values())
      const sent = channel.respondTo(requestId, result)
      if (sent === 'not-sent') {
        this.#answered.delete(requestId)
        await this.#storage?.saveAnswered(this.#answered.values())
        throw new CindlError(
          'offline',
          'Not connected to Hermes.',
          'request.answer: not sent',
        )
      }
      const answering: ServerRequest = { ...tracked.request, status: 'answering', answer }
      this.#emit({ type: 'request.opened', request: answering })
      this.#requests.delete(requestId)
      this.#emit({ type: 'request.closed', requestId, status: 'answered' })
      if (tracked.request.conversationId)
        this.#emit({
          type: 'session.status',
          conversationId: tracked.request.conversationId,
          status: 'working',
        })
      return { ...answering, status: 'answered' as const }
    },
    'routines.list': async () => {
      const raw = await this.#rpc('cron.manage', {
        action: 'list',
        include_disabled: true,
      })
      const result = wire.parseWire(wire.CronManageResult, raw)
      if (!result || result.success === false)
        throw new CindlError(
          'unavailable',
          'Hermes could not list its routines.',
          safeText(result?.error ?? 'cron.manage list'),
        )
      return (result.jobs ?? []).map(routineFromJob)
    },
    'routines.setEnabled': async ({ id, enabled }) => {
      const raw = await this.#rpc('cron.manage', {
        action: enabled ? 'resume' : 'pause',
        name: id,
      })
      const result = wire.parseWire(wire.CronManageResult, raw)
      if (!result?.success || !result.job)
        throw new CindlError(
          /not found/i.test(result?.error ?? '') ? 'not-found' : 'unavailable',
          'Hermes could not change that routine.',
          safeText(result?.error ?? 'cron.manage'),
        )
      return routineFromJob(result.job)
    },
    'skills.list': async () => (await this.#restOrThrow().skills()).map(skillFromRow),
    'skills.read': ({ name }) => this.#readSkill(name),
    'skills.write': async ({ name, content, expectedVersion }) => {
      const current = await this.#readSkill(name)
      if (current.version !== expectedVersion)
        throw new CindlError(
          'conflict',
          'This skill changed since you opened it. Review the new version first.',
        )
      await this.#restOrThrow().writeSkillContent(name, content)
      return this.#readSkill(name)
    },
    'soul.read': ({ profile }) => this.#readSoul(profile ?? this.#profile),
    'soul.write': async ({ profile, content, expectedVersion }) => {
      const name = profile ?? this.#profile
      const current = await this.#readSoul(name)
      if (current.version !== expectedVersion)
        throw new CindlError(
          'conflict',
          'SOUL.md changed since you opened it. Review the new version first.',
        )
      await this.#restOrThrow().writeSoul(name, content)
      return this.#readSoul(name)
    },
    'memory.overview': async () =>
      memoryOverviewFrom(await this.#restOrThrow().memory(), this.#now()),
    'connections.mcp': async () => {
      const result = wire.parseWire(
        wire.McpServersStatusResult,
        await this.#rpc('mcp.servers.status', {}),
      )
      if (!result)
        throw new CindlError(
          'protocol',
          'Hermes answered in an unexpected format.',
          'mcp.servers.status',
        )
      return mcpFromStatus(result)
    },
    'connections.accounts': () => {
      throw new CindlError('unsupported', unsupportedReasons['connections.accounts'])
    },
    'display.status': () => this.#readDisplay(),
    'display.acquireControl': async () => {
      if (!this.#display.viewerId || this.#display.viewerEpoch !== this.#epoch) {
        const observed = wire.parseWire(
          wire.DisplayObserveResult,
          await this.#rpc('display.observe', {}),
        )
        if (!observed)
          throw new CindlError(
            'protocol',
            'Hermes answered in an unexpected format.',
            'display.observe',
          )
        this.#display.viewerId = observed.viewer_id
        this.#display.viewerEpoch = this.#epoch
        this.#display.status = observed
      }
      const leased = wire.parseWire(
        wire.DisplayLeaseResult,
        await this.#rpc('display.lease.acquire', { viewer_id: this.#display.viewerId }),
      )
      if (!leased)
        throw new CindlError(
          'protocol',
          'Hermes answered in an unexpected format.',
          'display.lease.acquire',
        )
      this.#display.lease = leased.lease
      return this.#emitDisplay()
    },
    'display.releaseControl': async () => {
      const viewerId =
        this.#display.viewerEpoch === this.#epoch ? this.#display.viewerId : undefined
      if (!viewerId) {
        const state = this.#displayState()
        if (state.controller === 'you')
          throw new CindlError(
            'conflict',
            'This device took control on an earlier connection. Hermes binds control to that connection, so hand it back from the Hermes host or take control again first.',
          )
        return state
      }
      const leased = wire.parseWire(
        wire.DisplayLeaseResult,
        await this.#rpc('display.lease.release', { viewer_id: viewerId }),
      )
      if (!leased)
        throw new CindlError(
          'protocol',
          'Hermes answered in an unexpected format.',
          'display.lease.release',
        )
      this.#display.lease = leased.lease
      return this.#emitDisplay()
    },
  }

  /** Forget everything tied to the previous origin. */
  #reset(): void {
    this.#conversations.clear()
    this.#runtime.clear()
    this.#stored.clear()
    this.#watermark.clear()
    this.#historyLoaded.clear()
    this.#requests.clear()
    this.#answered.clear()
    this.#resent.clear()
    this.#noticed.clear()
    this.#prompts.clear()
    this.#handshake = undefined
    this.#status = undefined
    this.#signedIn = false
    this.#everOnline = false
    this.#epoch = 0
    this.#display = { previous: new Set() }
    this.#normalizer = this.#newNormalizer()
  }
}
