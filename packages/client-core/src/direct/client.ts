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
  hermesReasonOf,
  isBaselineVersion,
  mapServerRequest,
  mapUnsupportedRequest,
  MemoryEntries,
  mcpFromStatus,
  memoryOverviewFrom,
  NativeAuth,
  negotiateCapabilities,
  NotSentError,
  RestClient,
  routineFromJob,
  sendAnswer,
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
import { DirectStorage } from './storage.ts'

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
  /** Non-secret device storage: outbox, accepted prompt ids, epoch counter, main pin. */
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
    /** How often open request cards are checked against Hermes. Default 15 s. */
    requestSyncMs?: number
  }
}

export interface DirectClient extends CindlClientApi {
  /** Load device state, discover Hermes and connect when signed in. */
  start(): Promise<void>
  /** Close the connection. Device state stays; `start()` connects again. */
  stop(): void
}

type Handler<K extends OpName> = (args: OpArgs<K>) => Promise<OpResult<K>> | OpResult<K>

interface TrackedRequest {
  request: ServerRequest
  runtimeSessionId: string
  /** Absent only for an app-level `unsupported` prompt. */
  conversationId: string | undefined
}

type ReattachOutcome = 'ok' | 'gone' | 'abort'

const LOOPBACK_MODE =
  'Hermes is running in loopback-token mode. Cindl needs a sign-in provider (password or OAuth) and never reads the per-process dashboard token.'

/** `session.events.since` watermark that returns no events, only `open_requests`. */
const NO_EVENTS = Number.MAX_SAFE_INTEGER

/** Offline, timed out or never sent: worth retrying on the next connection. */
const isTransient = (error: unknown) =>
  error instanceof NotSentError ||
  (error instanceof CindlError && (error.code === 'offline' || error.code === 'timeout'))

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
  readonly #profile: string
  readonly #requestSyncMs: number
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
  /** Requests for a runtime session this socket has not bound yet: session id -> request id -> show it. */
  readonly #waiting = new Map<string, Map<string, () => void>>()
  readonly #prompts = new Map<string, PendingPrompt>()
  readonly #accepted = new Set<string>()
  #main: string | undefined
  #holding = false
  #held: HermesEventParams[] = []
  /** The learning-route probe for memory.text: once per sign-in; undefined until it answers. */
  #memoryProbe: 'responds' | 'missing' | undefined
  #display: {
    status?: Pick<wire.DisplayStatus, 'supported' | 'installed' | 'running'>
    lease?: wire.DisplayLease
    viewerId?: string
    viewerEpoch?: number
    previous: Set<string>
  } = { previous: new Set() }
  #listRefresh: unknown
  #requestSync: unknown
  #started = false
  #deviceLoaded = false

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
    this.#requestSyncMs = deps.connection?.requestSyncMs ?? 15_000
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
    if (!this.#deviceLoaded) await this.#loadDevice()
    await this.#discoverAndConnect()
  }

  stop(): void {
    this.#started = false
    this.#connection?.stop()
    this.#connection = undefined
    this.#handshake = undefined
    this.#deps.clock.clearTimeout(this.#listRefresh)
    this.#deps.clock.clearTimeout(this.#requestSync)
    const phase = this.#link.phase
    if (phase === 'online' || phase === 'connecting' || phase === 'reconnecting')
      this.#setLink('offline')
    this.#refreshCapabilities()
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
      this.#log.log('warn', 'direct.storage-failed', { name }),
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
    this.#deviceLoaded = true
    this.#epoch = await storage.loadEpoch()
    this.#main = await storage.loadMain()
    for (const clientId of await storage.loadAccepted()) this.#accepted.add(clientId)
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
      this.#offline(asCindlError(error, 'discovery'))
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
      this.#offline(asCindlError(error, 'auth.me'))
      return
    }
    if (!this.#signedIn) {
      this.#setLink('signed-out')
      this.#refreshCapabilities()
      return
    }
    this.#connect()
  }

  #offline(cause: CindlError): void {
    this.#setLink(isTransient(cause) ? 'offline' : 'error', cause)
    this.#refreshCapabilities()
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
        onUnhandledServerRequest: (request, epoch) =>
          this.#onUnhandledServerRequest(request, epoch),
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
      ...(this.#memoryProbe ? { memory: this.#memoryProbe } : {}),
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
        // stop() and sign-out set the phase themselves.
        break
    }
    this.#refreshCapabilities()
  }

  // --- reconnect reconciliation ----------------------------------------------------

  async #onReady(handshake: Handshake): Promise<void> {
    const previous = this.#handshake
    this.#handshake = handshake
    this.#epoch = handshake.connectionEpoch
    // Requests waiting for a binding belonged to the old socket; open_requests re-delivers them.
    this.#waiting.clear()
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
    let aborted = false
    try {
      for (const [storedId, oldSid] of [...this.#runtime]) {
        if (
          (await this.#reattach(storedId, oldSid, epochChanged, handshake)) === 'abort'
        ) {
          // The new socket failed or stalled; keep every binding for the next attempt.
          aborted = true
          break
        }
      }
    } finally {
      this.#holding = false
      const held = this.#held
      this.#held = []
      for (const params of held) this.#dispatchEvent(params)
    }
    if (aborted) {
      // A re-attach timed out on a socket that is still up: going online now
      // would leave the rest of the conversations unattached, their events and
      // requests reaching no one. Reconnect and reconcile again instead.
      if (this.#connection?.channel) this.#connection.restart('re-attach did not finish')
      return
    }
    void this.#flushOutbox()
    this.#scheduleListRefresh(0)
    void this.#syncAppLevel()
    void this.#probeDisplay()
    void this.#probeMemory()
    this.#scheduleRequestSync()
  }

  /**
   * Re-attach one session after a reconnect: resume it on this socket, replay
   * what this client missed when the numbering is unchanged (or reload history
   * when it is not), then report the requests Hermes still holds open for that
   * conversation. The replay runs before that report so a request Hermes
   * withdrew while this client was away closes with Hermes's reason; the
   * report then closes the ones that ended without an event (another client
   * answered them).
   */
  async #reattach(
    storedId: string,
    oldSid: string,
    epochChanged: boolean,
    handshake: Handshake,
  ): Promise<ReattachOutcome> {
    let before = this.#trackedIn(storedId)
    let snapshot: wire.SessionResumeResult
    try {
      snapshot = await this.#resume(storedId, true)
    } catch (error) {
      if (isTransient(error)) return 'abort'
      // Hermes answered, with an error: this session is gone for this socket
      // (not found, or a resume that fails on its side). The rest still
      // re-attach; opening the conversation later tries again.
      this.#log.log('warn', 'direct.reattach-failed', {
        code: asCindlError(error, 'resume').code,
      })
      this.#detachRuntime(storedId)
      this.#syncRequests(storedId, [], undefined, handshake.connectionEpoch)
      return 'gone'
    }
    const newSid = snapshot.session_id
    const watermark = this.#watermark.get(oldSid)
    let open: readonly wire.OpenRequestEntry[] = snapshot.open_requests ?? []
    let replay: readonly HermesEventParams[] = []
    if (newSid === oldSid && !epochChanged) {
      let since: wire.SessionEventsSinceResult | undefined
      const beforeSince = this.#trackedIn(storedId)
      try {
        since = wire.parseWire(
          wire.SessionEventsSinceResult,
          await this.#rpc('session.events.since', {
            session_id: newSid,
            last_seen: watermark ?? NO_EVENTS,
          }),
        )
      } catch (error) {
        if (isTransient(error)) return 'abort'
      }
      if (since) {
        open = since.open_requests
        before = beforeSince
      }
      if (watermark === undefined) this.#resetHistory(storedId, 'resync')
      else if (!since || since.epoch !== handshake.replayEpoch || since.truncated) {
        // The replay has a hole (or none came back): reload instead of trusting it.
        if (since) this.#watermark.set(newSid, Math.max(watermark, since.latest_seq))
        this.#resetHistory(storedId, since?.truncated ? 'truncated' : 'epoch-changed')
      } else replay = since.events as unknown as HermesEventParams[]
    } else {
      // A different runtime session or a restarted Hermes: the old numbering is gone.
      this.#normalizer.forgetSession(oldSid)
      this.#watermark.delete(oldSid)
      this.#resetHistory(storedId, epochChanged ? 'epoch-changed' : 'resync')
    }
    this.#connection?.channel?.deliverOpenRequests(open)
    for (const event of replay) this.#dispatchEvent(event)
    this.#releaseHeld(newSid)
    this.#syncRequests(
      storedId,
      open.map((entry) => entry.id),
      before,
      handshake.connectionEpoch,
    )
    return 'ok'
  }

  /** Apply one re-attached session's live events that arrived meanwhile, in order. */
  #releaseHeld(sid: string): void {
    const held = this.#held
    this.#held = held.filter((params) => params.session_id !== sid)
    for (const params of held) if (params.session_id === sid) this.#dispatchEvent(params)
  }

  #resetHistory(
    storedId: string,
    reason: 'epoch-changed' | 'truncated' | 'resync',
  ): void {
    if (!this.#historyLoaded.delete(storedId)) return
    this.#emit({ type: 'history.reset', conversationId: storedId, reason })
  }

  /**
   * Report what Hermes holds open for one conversation. A tracked request the
   * snapshot leaves out closed without an event (another client answered it),
   * unless it was not yet tracked when the snapshot was asked for (`before`):
   * then it is newer than the snapshot and still open.
   */
  #syncRequests(
    /** A conversation, or undefined for the app-level scope (requests with none). */
    conversationId: string | undefined,
    listed: readonly string[],
    before?: ReadonlySet<string>,
    /** The connection the list came from. */
    epoch: number = this.#epoch,
  ): void {
    const open = new Set(listed)
    for (const [requestId, tracked] of [...this.#requests]) {
      if (tracked.conversationId !== conversationId || open.has(requestId)) continue
      if (before && !before.has(requestId)) open.add(requestId)
      else this.#requests.delete(requestId)
    }
    this.#emit({
      type: 'requests.synced',
      ...(conversationId ? { conversationId } : {}),
      openRequestIds: [...open],
      connectionEpoch: epoch,
    })
  }

  /**
   * App-level prompts (empty session_id, such as display.install.sudo) belong to
   * the Hermes surface that started the operation, which gets the frame; Cindl
   * starts none. `session.events.since {session_id: ""}` lists every
   * connection's open ones (methods_session.py:2309-2323, server.py:797-810).
   * Show the listed ones not seen yet and close only what the list no longer
   * holds. A disconnect cancels nothing app-level (Hermes waits out the prompt's
   * own timeout), so when the list cannot be read nothing changes.
   */
  async #syncAppLevel(): Promise<void> {
    const before = this.#trackedIn(undefined)
    const epoch = this.#epoch
    let since: wire.SessionEventsSinceResult | undefined
    try {
      since = wire.parseWire(
        wire.SessionEventsSinceResult,
        await this.#rpc('session.events.since', { session_id: '', last_seen: NO_EVENTS }),
      )
    } catch {
      return
    }
    if (!since || epoch !== this.#epoch) return
    const unseen = since.open_requests.filter((entry) => !this.#requests.has(entry.id))
    this.#connection?.channel?.deliverOpenRequests(unseen)
    this.#syncRequests(
      undefined,
      since.open_requests.map((entry) => entry.id),
      before,
      epoch,
    )
  }

  #trackedIn(conversationId: string | undefined): Set<string> {
    const ids = new Set<string>()
    for (const [requestId, tracked] of this.#requests)
      if (tracked.conversationId === conversationId) ids.add(requestId)
    return ids
  }

  /**
   * On `hermes serve` v0.22.5 an answer from another client produces no
   * event here (server_requests.py:281-317), so while a card is open the
   * client asks Hermes which requests are still open in that conversation.
   */
  #scheduleRequestSync(): void {
    this.#deps.clock.clearTimeout(this.#requestSync)
    if (!this.#requests.size || this.#requestSyncMs <= 0) return
    this.#requestSync = this.#deps.clock.setTimeout(() => {
      void this.#syncOpenRequests()
    }, this.#requestSyncMs)
  }

  async #syncOpenRequests(): Promise<void> {
    const conversations = new Set(
      [...this.#requests.values()].flatMap((tracked) =>
        tracked.conversationId ? [tracked.conversationId] : [],
      ),
    )
    for (const conversationId of conversations) {
      const sid = this.#runtime.get(conversationId)
      if (!sid) continue
      const before = this.#trackedIn(conversationId)
      const epoch = this.#epoch
      try {
        const since = wire.parseWire(
          wire.SessionEventsSinceResult,
          await this.#rpc('session.events.since', {
            session_id: sid,
            last_seen: NO_EVENTS,
          }),
        )
        if (since)
          this.#syncRequests(
            conversationId,
            since.open_requests.map((entry) => entry.id),
            before,
            epoch,
          )
      } catch {
        // Next tick, or the reconnect, tries again.
      }
    }
    await this.#syncAppLevel()
    this.#scheduleRequestSync()
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
        // `resolved`: settled from another surface (approval_gateway_wait.py:209-221).
        this.#closeRequest(
          effect.requestId,
          effect.reason === 'resolved'
            ? 'resolved-elsewhere'
            : effect.reason === 'timeout'
              ? 'expired'
              : 'cancelled',
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
          // Hermes tore the runtime session down (session_lifecycle.py:545-560): nothing it
          // held for it can be answered or re-listed any more.
          for (const [requestId, tracked] of [...this.#requests])
            if (tracked.conversationId === storedId)
              this.#closeRequest(requestId, 'cancelled')
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
    const waiting = this.#waiting.get(sid)
    this.#waiting.delete(sid)
    for (const show of waiting?.values() ?? []) show()
  }

  /**
   * A request can beat the reply that binds its session (session.resume
   * attaches before it answers): show it once the binding lands. It stays open
   * in Hermes meanwhile. Only for the current socket; a reconnect re-lists it.
   */
  #waitForBinding(sid: string, requestId: string, epoch: number, show: () => void): void {
    if (!sid || epoch !== this.#epoch) return
    const waiting = this.#waiting.get(sid) ?? new Map<string, () => void>()
    if (waiting.size >= 20 && !waiting.has(requestId)) return
    waiting.set(requestId, show)
    this.#waiting.set(sid, waiting)
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
    if (snapshot.running && this.#conversations.has(storedId))
      this.#emit({ type: 'session.status', conversationId: storedId, status: 'working' })
    return snapshot
  }

  /** Attach a stored session to this socket and reconcile its open requests. */
  async #attachWithSnapshot(
    storedId: string,
    omitMessages: boolean,
  ): Promise<wire.SessionResumeResult> {
    const before = this.#trackedIn(storedId)
    const epoch = this.#epoch
    const snapshot = await this.#resume(storedId, omitMessages)
    const open = snapshot.open_requests ?? []
    this.#connection?.channel?.deliverOpenRequests(open)
    this.#syncRequests(
      storedId,
      open.map((entry) => entry.id),
      before,
      epoch,
    )
    return snapshot
  }

  /** The runtime id of a stored session, attaching it to this socket when needed. */
  async #attach(storedId: string): Promise<string> {
    const known = this.#runtime.get(storedId)
    if (known) return known
    return (await this.#attachWithSnapshot(storedId, true)).session_id
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
    if (!connection) throw new NotSentError(`${method}: no connection`)
    return connection.request(method, params)
  }

  #restOrThrow(): RestClient {
    if (!this.#rest) throw new CindlError('unavailable', 'Choose a Hermes server first.')
    return this.#rest
  }

  // --- server requests ----------------------------------------------------------------

  #onServerRequest(inbound: InboundServerRequest, epoch: number): void {
    const sid =
      typeof inbound.params.session_id === 'string' ? inbound.params.session_id : ''
    const conversationId = this.#stored.get(sid)
    if (!conversationId) {
      this.#waitForBinding(sid, inbound.id, epoch, () =>
        this.#onServerRequest(inbound, epoch),
      )
      this.#log.log('info', 'direct.request-session-not-bound', {
        method: inbound.method,
      })
      return
    }
    const existing = this.#requests.get(inbound.id)
    const mapped = mapServerRequest({
      requestId: inbound.id,
      method: inbound.method,
      params: inbound.params,
      lastSeenEpoch: epoch,
      receivedAt: existing?.request.receivedAt ?? this.#now(),
      conversationId,
    })
    // A frame Cindl cannot read stays open for clients that can.
    if (!mapped) {
      this.#log.log('warn', 'direct.request-unreadable', { method: inbound.method })
      return
    }
    this.#requests.set(inbound.id, {
      request: mapped.request,
      runtimeSessionId: mapped.runtimeSessionId,
      conversationId,
    })
    // Hermes holds it open, so even a request this client answered before is
    // answerable again: that answer did not land (the reducer reopens it).
    this.#emit({ type: 'request.opened', request: mapped.request })
    this.#emit({ type: 'session.status', conversationId, status: 'waiting-on-you' })
    this.#scheduleRequestSync()
  }

  /**
   * A request Cindl never answers. Nothing is sent; it is shown read-only as
   * `unsupported` in its conversation so the owner knows Hermes is waiting,
   * and closes like any other request (withdrawn, timed out, or gone from
   * Hermes's open list once another surface answered it).
   */
  #onUnhandledServerRequest(request: UnhandledServerRequest, epoch: number): void {
    if (request.action !== 'leave-open') return
    const sid = request.sessionId ?? ''
    // An app-level prompt (empty session_id) belongs to no conversation and is
    // shown only in Work; a session-scoped one waits for its binding.
    const conversationId = sid ? this.#stored.get(sid) : undefined
    if (sid && !conversationId) {
      this.#waitForBinding(sid, request.id, epoch, () =>
        this.#onUnhandledServerRequest(request, epoch),
      )
      return
    }
    const existing = this.#requests.get(request.id)
    const mapped = mapUnsupportedRequest({
      requestId: request.id,
      method: request.method,
      sessionId: sid,
      lastSeenEpoch: epoch,
      receivedAt: existing?.request.receivedAt ?? this.#now(),
      ...(conversationId ? { conversationId } : {}),
    })
    if (!mapped) return
    this.#requests.set(request.id, {
      request: mapped.request,
      runtimeSessionId: mapped.runtimeSessionId,
      conversationId,
    })
    this.#emit({ type: 'request.opened', request: mapped.request })
    if (conversationId)
      this.#emit({ type: 'session.status', conversationId, status: 'waiting-on-you' })
    this.#scheduleRequestSync()
  }

  #closeRequest(
    requestId: string,
    status: 'answered' | 'resolved-elsewhere' | 'cancelled' | 'expired',
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

  /**
   * Send one recorded prompt. Only a prompt still `queued-offline` is sent, so
   * a discard or a second flush always wins; and only after the `sending`
   * record is durable, so a crash can never lead to a second send.
   */
  async #send(
    prompt: PendingPrompt,
    options: { queued: boolean },
  ): Promise<PendingPrompt> {
    const clientId = prompt.clientId
    const current = this.#prompts.get(clientId)
    if (!current)
      return { ...prompt, state: 'failed', error: 'Discarded before it was sent.' }
    if (current.state !== 'queued-offline') return current
    const sending: PendingPrompt = { ...current, state: 'sending' }
    this.#prompts.set(clientId, sending)
    this.#emit({ type: 'prompt.updated', prompt: sending })
    const durable = (await this.#storage?.saveOutbox(this.#prompts.values())) ?? true
    if (!durable)
      return this.#setPrompt({
        ...current,
        error: 'This device could not record the message, so it was not sent.',
      })
    let sid: string
    try {
      sid = await this.#attach(current.conversationId)
    } catch (error) {
      const cause = asCindlError(error, 'attach')
      return this.#setPrompt(
        isTransient(cause)
          ? current
          : { ...current, state: 'failed', error: cause.message },
      )
    }
    let raw: unknown
    try {
      raw = await this.#rpc('prompt.submit', {
        session_id: sid,
        text: current.text,
        // A prompt written while offline waits behind a running turn instead of
        // redirecting it (prompt_voice.py:35, session_auto_continue.py:400-406).
        ...(options.queued ? { queued: true } : {}),
      })
    } catch (error) {
      if (error instanceof NotSentError) return this.#setPrompt(current)
      const cause = asCindlError(error, 'prompt.submit')
      // A timeout or a drop after sending: Hermes may have run it. Never resent.
      if (isTransient(cause))
        return this.#setPrompt({
          ...current,
          state: 'uncertain',
          error:
            'The connection dropped before Hermes confirmed this message. It was not resent.',
        })
      return this.#setPrompt({ ...current, state: 'failed', error: cause.message })
    }
    const result = wire.parseWire(wire.PromptSubmitResult, raw)
    this.#accepted.add(clientId)
    void this.#storage?.saveAccepted(this.#accepted)
    const accepted = this.#setPrompt({
      ...current,
      state: 'accepted',
      ...(result?.status ? { disposition: result.status } : {}),
    })
    const messageId = `prompt:${clientId}`
    this.#emit({
      type: 'message.started',
      conversationId: current.conversationId,
      messageId,
      role: 'user',
    })
    this.#emit({
      type: 'message.completed',
      conversationId: current.conversationId,
      messageId,
      status: 'complete',
      text: current.text,
    })
    return accepted
  }

  /** A prompt Hermes accepted earlier on this device (its record is no longer kept). */
  #acceptedRecord(clientId: string, conversationId: string, text: string): PendingPrompt {
    return { clientId, conversationId, text, createdAt: this.#now(), state: 'accepted' }
  }

  async #flushOutbox(): Promise<void> {
    const queued = [...this.#prompts.values()]
      .filter((p) => p.state === 'queued-offline')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const prompt of queued) {
      if (!this.#connection?.channel) return
      // Re-read each time: a discard during the flush wins.
      if (this.#prompts.get(prompt.clientId)?.state !== 'queued-offline') continue
      await this.#send(prompt, { queued: true })
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

  /**
   * memory.text needs Hermes's learning routes; a read-only GET of the entry
   * list proves them. A 404 means this Hermes has none. Anything else leaves it
   * unknown until the next reconnect tries again.
   */
  async #probeMemory(): Promise<void> {
    if (this.#memoryProbe || !this.#signedIn) return
    try {
      await this.#restOrThrow().learningGraph(this.#profile)
      this.#memoryProbe = 'responds'
    } catch (error) {
      if (asCindlError(error, 'learning graph').code !== 'not-found') return
      this.#memoryProbe = 'missing'
    }
    this.#refreshCapabilities()
  }

  #memoryEntries(): MemoryEntries {
    return new MemoryEntries({
      rest: this.#restOrThrow(),
      sha256Hex,
      now: () => this.#now(),
    })
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
      this.#started = true
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
      this.#memoryProbe = undefined
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
            hermesReasonOf(cause) === 'revision_conflict' &&
            attempt === 0
          )
            continue
          throw cause
        }
      }
      return this.#upsert({ ...conversation, title, updatedAt: this.#now() })
    },
    'conversations.history': async ({ conversationId }) => {
      const snapshot = await this.#attachWithSnapshot(conversationId, false)
      const history = transcriptToHistory(conversationId, snapshot.messages)
      for (const activity of history.tools) this.#emit({ type: 'tool.updated', activity })
      this.#historyLoaded.add(conversationId)
      this.#emit({ type: 'history.loaded', conversationId, messages: history.messages })
      return history
    },
    'prompt.submit': async ({ conversationId, clientId, text }) => {
      // Never send the same client prompt twice, even after a restart.
      if (this.#accepted.has(clientId) && !this.#prompts.has(clientId))
        return this.#acceptedRecord(clientId, conversationId, text)
      const existing = this.#prompts.get(clientId)
      if (existing) return existing
      this.#conversationOrThrow(conversationId)
      const prompt = this.#setPrompt({
        clientId,
        conversationId,
        text,
        createdAt: this.#now(),
        state: 'queued-offline',
      })
      if (!this.#connection?.channel) return prompt
      return this.#send(prompt, { queued: false })
    },
    'prompt.discard': async ({ clientId }) => {
      const prompt = this.#prompts.get(clientId)
      if (!prompt || prompt.state === 'accepted' || prompt.state === 'sending')
        return { discarded: false }
      this.#prompts.delete(clientId)
      await this.#storage?.saveOutbox(this.#prompts.values())
      this.#emit({ type: 'prompt.removed', clientId })
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
      // Nothing is ever sent for these: any reply could become the password.
      if (tracked.request.kind === 'unsupported')
        throw new CindlError(
          'unsupported',
          'Cindl does not answer this request. Answer it where Hermes asked.',
        )
      this.#require(
        tracked.request.kind === 'approval' ? 'requests.approval' : 'requests.clarify',
      )
      const result = answerResult(tracked.request, answer)
      // The attempt is identified by the connection it goes out on (the live
      // channel and #epoch change together): the answering record and every
      // outcome carry that epoch, so the reducer can tell this attempt apart
      // from an older one.
      const epoch = this.#epoch
      const answering: ServerRequest = {
        ...tracked.request,
        lastSeenEpoch: epoch,
        status: 'answering',
        answer,
      }
      // No second answer from this device while this one is on its way.
      this.#requests.delete(requestId)
      this.#emit({ type: 'request.opened', request: answering })
      const outcome = await sendAnswer(
        (method, params) => this.#rpc(method, params),
        requestId,
        result,
      )
      // Exactly one event ends `answering`.
      if (outcome.kind === 'answered') {
        // Hermes's request registry took it; not proof that a command or tool
        // succeeded. A history load may have re-listed it meanwhile from an older
        // snapshot; that copy is not answerable any more.
        this.#requests.delete(requestId)
        this.#emit({
          type: 'request.closed',
          requestId,
          status: 'answered',
          connectionEpoch: epoch,
          answer,
        })
        if (tracked.conversationId)
          this.#emit({
            type: 'session.status',
            conversationId: tracked.conversationId,
            status: 'working',
          })
        return { ...answering, status: 'answered' as const }
      }
      if (outcome.kind === 'no-longer-pending') {
        this.#requests.delete(requestId)
        this.#emit({
          type: 'request.closed',
          requestId,
          status: 'resolved-elsewhere',
          connectionEpoch: epoch,
        })
        return { ...answering, status: 'resolved-elsewhere' as const }
      }
      // Answerable again (unless Hermes re-listed it meanwhile). If the answer
      // did land, a second one is told the request already ended.
      if (!this.#requests.has(requestId)) this.#requests.set(requestId, tracked)
      this.#emit({ type: 'request.answer-failed', requestId, connectionEpoch: epoch })
      if (!outcome.delivered)
        throw new CindlError(
          'offline',
          'Not connected to Hermes. The answer was not sent.',
          outcome.error.detail,
        )
      if (outcome.error.code === 'offline' || outcome.error.code === 'timeout')
        throw new CindlError(
          outcome.error.code,
          'Hermes did not confirm this answer. Answering again is safe: if the first one counted, Hermes says the request already ended.',
          outcome.error.detail,
        )
      throw new CindlError(
        outcome.error.code,
        'Hermes did not accept this answer. The request is still open.',
        outcome.error.detail,
      )
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
          'cron.manage list',
        )
      return (result.jobs ?? []).map(routineFromJob)
    },
    'routines.setEnabled': async ({ id, enabled }) => {
      const raw = await this.#rpc('cron.manage', {
        action: enabled ? 'resume' : 'pause',
        name: id,
      })
      const result = wire.parseWire(wire.CronManageResult, raw)
      if (!result?.success || !result.job) {
        const missing = /not found/i.test(result?.error ?? '')
        throw new CindlError(
          missing ? 'not-found' : 'unavailable',
          missing
            ? 'That routine no longer exists.'
            : 'Hermes could not change that routine.',
          `cron.manage ${enabled ? 'resume' : 'pause'}`,
        )
      }
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
    // Gated on memory.text: available only once the learning routes answered.
    // The fingerprint in each id is the entry's version; Hermes refuses a stale
    // one (conflict) and text over its store limit (invalid). No undo.
    'memory.entries': () => this.#memoryEntries().list(this.#profile),
    'memory.read': ({ id }) => this.#memoryEntries().read(id, this.#profile),
    'memory.write': ({ id, content }) =>
      this.#memoryEntries().write(id, content, { confirm: true, profile: this.#profile }),
    'memory.delete': ({ id }) =>
      this.#memoryEntries().delete(id, { confirm: true, profile: this.#profile }),
    'display.status': () => this.#readDisplay(),
    // The live picture (ADR 0012) is not wired in this client yet.
    'display.watch': () => {
      throw new CindlError(
        'unsupported',
        'The live screen is not wired in this client yet.',
      )
    },
    'display.frame': () => {
      throw new CindlError(
        'unsupported',
        'The live screen is not wired in this client yet.',
      )
    },
    'display.unwatch': () => ({ stopped: false }),
    'display.input': () => {
      throw new CindlError(
        'unsupported',
        'The live screen is not wired in this client yet.',
      )
    },
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
    this.#waiting.clear()
    this.#prompts.clear()
    this.#accepted.clear()
    this.#handshake = undefined
    this.#status = undefined
    this.#signedIn = false
    this.#everOnline = false
    this.#deviceLoaded = false
    this.#epoch = 0
    this.#display = { previous: new Set() }
    this.#memoryProbe = undefined
    this.#normalizer = this.#newNormalizer()
  }
}
