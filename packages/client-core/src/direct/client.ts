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
  hermesDidNotAnswer,
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
  BinaryWebSocketFactory,
  Clock,
  KeyValueStore,
  LoopbackAuthorizer,
  SecretStore,
  WebSocketFactory,
} from '../platform.ts'
import { sha256Hex } from '../sha256.ts'
import { LiveScreen, screenStoppedError } from './screen.ts'
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
  /**
   * Opens the agent screen's binary WebSocket for the live picture (ADR 0012).
   * Without it computer.view stays `limited`: the screen state and lease only.
   */
  displaySocketFactory?: BinaryWebSocketFactory
  clock: Clock
  /** Non-secret device storage: outbox, accepted prompt ids, epoch counter, main pin. */
  kv: KeyValueStore
  /** Native only: OS-backed token storage. */
  secrets?: SecretStore
  /** Native only: randomness and SHA-256 for PKCE. */
  crypto?: CryptoProvider
  /** Native only: the system-browser + loopback leg of sign-in. */
  authorizer?: LoopbackAuthorizer
  /**
   * A Hermes profile the platform pins for SOUL.md and memory entries.
   * Without one Cindl uses the profile Hermes serves: no `profile` on the
   * learning routes, and for SOUL.md the name display.status reports.
   */
  profile?: string
  /**
   * Cookie mode (web): the platform's cue that this browser's Hermes session
   * may have changed elsewhere, such as the page becoming visible again or
   * another tab announcing its sign-out. The client then asks
   * GET /api/auth/me at once instead of at its next request tick. Returns an
   * unsubscribe; the client subscribes while connected.
   */
  watchSession?: (check: () => void) => () => void
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

/** The gate's `error` when a browser session is over (middleware.py:72-87). */
const SESSION_OVER = new Set(['unauthenticated', 'session_expired'])

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

/** The pieces that talk to one Hermes origin. */
interface OriginParts {
  origin: string
  storage: DirectStorage
  native: NativeAuth | undefined
  rest: RestClient
}

class DirectHermesClient implements DirectClient {
  readonly #deps: DirectClientDeps
  readonly #log: Diagnostics
  /** The live picture; undefined when the platform has no binary WebSocket. */
  readonly #screen: LiveScreen | undefined
  readonly #listeners = new Set<(event: CindlEvent) => void>()
  /** The platform's pinned profile, if any. */
  readonly #configuredProfile: string | undefined
  /**
   * The served profile's name from display.status: undefined until known,
   * null when Hermes serves a home no profile name addresses.
   */
  #servedProfile: string | null | undefined
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
    /** Only these fields: never the spent ticket or viewer id of an observe answer. */
    status?: Pick<wire.DisplayStatus, 'supported' | 'installed' | 'running'>
    lease?: wire.DisplayLease
    /**
     * SHA-256 of the served profile's `profile_key` (a host path, never
     * emitted). Hermes broadcasts display events for every profile.
     */
    profile?: string
    viewerId?: string
    viewerEpoch?: number
    /**
     * This device's viewer ids from earlier connections, by viewer hash. Never
     * emitted or logged; used to recognise and release their lease.
     */
    previous: Map<string, string>
  } = { previous: new Map() }
  #listRefresh: unknown
  #requestSync: unknown
  #started = false
  /**
   * Bumped by start(), stop() and sign-in: work begun under an older value
   * (a discovery, a sign-in) neither connects nor changes the link.
   */
  #run = 0
  #discoveryRetry: unknown
  #discoveryAttempt = 0
  /** A link was reported: from then on a new subscriber is told the state so far. */
  #reported = false
  /** The screen state last reported, as it was reported. */
  #lastDisplay: DisplayState | undefined
  /** Cookie mode: the session check in flight, so a tick and a cue share one request. */
  #sessionCheck: { run: number; done: Promise<void> } | undefined
  /** A cue came while a check was in flight, so one more check follows it. */
  #sessionRecheck = false
  #unwatchSession: (() => void) | undefined
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
    this.#configuredProfile =
      deps.profile === undefined ? undefined : ProfileName.parse(deps.profile)
    this.#requestSyncMs = deps.connection?.requestSyncMs ?? 15_000
    this.#screen = deps.displaySocketFactory
      ? new LiveScreen({
          factory: deps.displaySocketFactory,
          clock: deps.clock,
          origin: () => this.#origin ?? '',
          observe: (viewerId) => this.#observeDisplay(viewerId ?? this.#display.viewerId),
          holdsLease: (viewerId) => this.#holdsLease(viewerId),
          screenRunning: async () => {
            try {
              await this.#readDisplay()
              return this.#display.status?.running
            } catch {
              return undefined
            }
          },
          newViewId: () => `view-${this.#id()}`,
          log: (event, fields) => this.#log.log('info', event, fields),
        })
      : undefined
    if (deps.origin) this.#configure(HermesOrigin.parse(deps.origin))
  }

  // --- CindlClientApi --------------------------------------------------------

  subscribe(listener: (event: CindlEvent) => void): () => void {
    this.#listeners.add(listener)
    // A subscriber that joins late, such as a renderer an error boundary
    // remounted with a new store, is told what the others already know.
    // Before the first link there is nothing to tell.
    if (this.#reported) for (const event of this.#known()) this.#deliver(listener, event)
    return () => this.#listeners.delete(listener)
  }

  /** This client's state so far, as the events that build it in a new store. */
  #known(): CindlEvent[] {
    const known: CindlEvent[] = [
      { type: 'link.changed', link: this.#link },
      { type: 'capabilities.changed', capabilities: this.#capabilities },
    ]
    for (const conversation of this.#conversations.values())
      known.push({ type: 'conversation.upserted', conversation })
    for (const prompt of this.#prompts.values())
      known.push({ type: 'prompt.updated', prompt })
    for (const { request } of this.#requests.values())
      known.push({ type: 'request.opened', request })
    if (this.#lastDisplay)
      known.push({ type: 'display.changed', display: this.#lastDisplay })
    return known
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
    // display.unwatch only closes a view on this device, and it is needed
    // exactly when the screen stops being available (a dropped link).
    const local = name === 'display.unwatch'
    if (capability && !queueable && !probe && !local) this.#require(capability)
    const handler = this.#handlers[name] as unknown as (a: typeof parsed) => unknown
    const run = this.#run
    try {
      return (await handler(parsed)) as OpResult<K>
    } catch (error) {
      const cause = asCindlError(error, name)
      if (this.#sessionEndedByHermes(cause, run)) this.#sessionEnded(cause)
      throw cause
    }
  }

  /**
   * Cookie mode: the gate's 401 saying the browser's session is over, because
   * no cookies came or the refresh cookie failed too (middleware.py:150-157,
   * 186-211). Hermes's own web app goes to the login page on exactly these two
   * (web/src/lib/api.ts:209-240); any other 401 is an error of its own. Native
   * mode refreshes its tokens itself. The answer speaks only for the run its
   * request was sent in: once a stop() or a new sign-in has moved the run on,
   * a late 401 says nothing about the session signed in since.
   */
  #sessionEndedByHermes(cause: CindlError, run: number): boolean {
    return (
      run === this.#run &&
      !this.#native &&
      this.#signedIn &&
      cause.code === 'unauthenticated' &&
      SESSION_OVER.has(hermesReasonOf(cause))
    )
  }

  #sessionEnded(cause: CindlError): void {
    this.stop()
    this.#forgetSession()
    this.#setLink('signed-out', cause)
    this.#refreshCapabilities()
  }

  /**
   * The session is over, signed out here or ended by Hermes: forget what
   * belonged to it. Open request cards close, since nothing here can answer
   * them now; after a new sign-in, Hermes shows again the ones it still holds.
   */
  #forgetSession(): void {
    this.#signedIn = false
    this.#memoryProbe = undefined
    for (const requestId of [...this.#requests.keys()])
      this.#closeRequest(requestId, 'cancelled')
  }

  /**
   * Cookie mode: POST /auth/logout, so Hermes clears the HttpOnly cookies,
   * which nothing else can. Its redirect alone proves little, since a proxy
   * in front of Hermes can answer one just the same, so GET /api/auth/me must
   * then answer the gate's 401. Whether a copy of the cookies stops working
   * depends on the provider: basic and Nous Portal revoke nothing, and
   * self-hosted OIDC revokes the refresh token only when its IdP has a
   * revocation endpoint (self_hosted/__init__.py:124-145); an access cookie
   * lasts until it expires. A failure never blocks the local sign-out; it is
   * shown. Resolves whether Hermes confirmed it.
   */
  async #endCookieSession(): Promise<boolean> {
    const rest = this.#rest
    if (!rest) return false
    let confirmed = false
    try {
      await rest.logout()
      confirmed = await this.#sessionGone(rest)
      if (!confirmed) this.#log.log('warn', 'direct.logout-unconfirmed', {})
    } catch (error) {
      this.#log.log('warn', 'direct.logout-failed', {
        code: asCindlError(error, 'auth.logout').code,
      })
    }
    if (!confirmed)
      this.#emit({
        type: 'notice',
        level: 'warning',
        message:
          'Hermes did not confirm the sign-out, so its session cookie may still sign this browser in. Sign out again.',
      })
    return confirmed
  }

  /** GET /api/auth/me answers the gate's 401: this browser has no Hermes session. */
  async #sessionGone(rest: RestClient): Promise<boolean> {
    try {
      await rest.me()
      return false
    } catch (error) {
      const cause = asCindlError(error, 'auth.me')
      return cause.code === 'unauthenticated' && SESSION_OVER.has(hermesReasonOf(cause))
    }
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    const run = ++this.#run
    this.#discoveryAttempt = 0
    if (!this.#origin) {
      // The link starts out unconfigured, so #setLink stays silent here and a
      // renderer waiting for its first link would wait forever: say it once.
      this.#setLink('unconfigured')
      this.#emit({ type: 'link.changed', link: this.#link })
      this.#capabilitiesJson = ''
      this.#refreshCapabilities()
      return
    }
    if (!this.#deviceLoaded) await this.#loadDevice()
    await this.#discoverAndConnect(run)
  }

  stop(): void {
    this.#started = false
    this.#run++
    this.#deps.clock.clearTimeout(this.#discoveryRetry)
    this.#unwatchSession?.()
    this.#unwatchSession = undefined
    this.#screen?.close()
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

  /** What talks to one Hermes origin, built before a sign-in and installed once it succeeds. */
  #parts(origin: string): OriginParts {
    const storage = new DirectStorage(this.#deps.kv, origin, (name) =>
      this.#log.log('warn', 'direct.storage-failed', { name }),
    )
    const timers: Timers = this.#deps.clock
    let native: NativeAuth | undefined
    if (this.#deps.auth === 'native-pkce') {
      if (!this.#deps.secrets || !this.#deps.crypto)
        throw new CindlError(
          'invalid',
          'Native sign-in needs a secret store and crypto provider.',
        )
      native = new NativeAuth({
        origin,
        fetch: this.#deps.fetch,
        timers,
        secrets: this.#deps.secrets,
        crypto: this.#deps.crypto,
        diagnostics: this.#log,
      })
    }
    const rest = new RestClient({
      origin,
      fetch: this.#deps.fetch,
      timers,
      auth: native ? native.restAuth() : { kind: 'cookie' },
      diagnostics: this.#log,
    })
    return { origin, storage, native, rest }
  }

  #install(parts: OriginParts): void {
    this.#origin = parts.origin
    this.#storage = parts.storage
    this.#native = parts.native
    this.#rest = parts.rest
  }

  #configure(origin: string): void {
    this.#install(this.#parts(origin))
  }

  /** Leave the current origin and take up `parts`: nothing of the old session survives. */
  async #switchTo(parts: OriginParts): Promise<void> {
    // Retire the sign-in left behind first: a refresh it still has in flight
    // must never write the old origin's tokens back once the platform deleted
    // them, nor touch a record for the same origin signed in again.
    if (this.#native !== parts.native) this.#native?.retire()
    this.stop()
    this.#reset()
    this.#install(parts)
    await this.#loadDevice()
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

  /**
   * Ask Hermes what it is and whether this device is signed in, then
   * connect. Each await may outlast the run that started it: stop(), or a
   * newer start or sign-in, takes over, and then this one only returns.
   */
  async #discoverAndConnect(run: number): Promise<void> {
    const rest = this.#rest
    if (!rest || run !== this.#run) return
    // A retry keeps showing why the last attempt failed until one succeeds.
    if (!this.#discoveryAttempt) this.#setLink('connecting')
    let status: wire.StatusResponse
    try {
      status = await rest.status()
    } catch (error) {
      this.#discoveryFailed(asCindlError(error, 'discovery'), run)
      return
    }
    if (run !== this.#run) return
    this.#status = status
    if (status.auth_required === false) {
      this.#setLink('incompatible', new CindlError('unsupported', LOOPBACK_MODE))
      this.#refreshCapabilities()
      return
    }
    let signedIn: boolean
    try {
      signedIn = await this.#checkSignedIn()
    } catch (error) {
      this.#discoveryFailed(asCindlError(error, 'auth.me'), run)
      return
    }
    if (run !== this.#run) return
    this.#discoveryAttempt = 0
    this.#signedIn = signedIn
    if (!signedIn) {
      this.#setLink('signed-out')
      this.#refreshCapabilities()
      return
    }
    this.#connect()
  }

  /**
   * When Hermes did not answer discovery (no network, a timeout, a 5xx while
   * it restarts, rate limiting), the link is offline with the cause and
   * discovery runs again with the connection's backoff. Any other failure is
   * an error to show, not to repeat: an answer that is not Hermes, a
   * refusal, or a failure on this device, such as a secret store that cannot
   * be read, which asking Hermes again cannot fix.
   */
  #discoveryFailed(cause: CindlError, run: number): void {
    if (run !== this.#run) return
    if (!hermesDidNotAnswer(cause)) {
      this.#setLink('error', cause)
      this.#refreshCapabilities()
      return
    }
    this.#setLink('offline', cause)
    this.#refreshCapabilities()
    this.#deps.clock.clearTimeout(this.#discoveryRetry)
    this.#discoveryRetry = this.#deps.clock.setTimeout(() => {
      void this.#discoverAndConnect(run)
    }, this.#retryDelay(this.#discoveryAttempt++))
  }

  /** The connection's reconnect backoff (HermesConnection), jitter included. */
  #retryDelay(attempt: number): number {
    const { initialMs, maxMs } = this.#deps.connection?.backoff ?? {
      initialMs: 1_000,
      maxMs: 30_000,
    }
    const base = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 10))
    return Math.round(base * (0.8 + 0.4 * (this.#deps.random ?? Math.random)()))
  }

  async #checkSignedIn(): Promise<boolean> {
    if (this.#native) return (await this.#native.identity()) !== undefined
    return this.#rest ? this.#cookieSignedIn(this.#rest) : false
  }

  /** The web session cookie still answers `GET /api/auth/me`. */
  async #cookieSignedIn(rest: RestClient): Promise<boolean> {
    try {
      await rest.me()
      return true
    } catch (error) {
      const cause = asCindlError(error, 'auth.me')
      if (cause.code === 'unauthenticated') return false
      throw cause
    }
  }

  #currentParts(): OriginParts {
    const origin = this.#origin
    const storage = this.#storage
    const rest = this.#rest
    if (!origin || !storage || !rest)
      throw new CindlError('unavailable', 'Choose a Hermes server first.')
    return { origin, storage, native: this.#native, rest }
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
    if (!this.#native && !this.#unwatchSession && this.#deps.watchSession)
      this.#unwatchSession = this.#deps.watchSession(() => void this.#checkSession(true))
  }

  /**
   * Cookie mode: does this browser still have its Hermes session? Hermes
   * checks one only when a socket opens (chat_ws.py:137-171), so a tab whose
   * cookies another tab's sign-out cleared would otherwise keep talking on
   * its open socket. Asked on the request tick and on the platform's cue; the
   * gate's 401 ends the session here, any other failure waits for the next
   * check. A tick shares a check in flight. A cue may come after that check
   * was sent (another tab signed out since), so one more check follows it.
   */
  #checkSession(cue = false): Promise<void> {
    const rest = this.#rest
    if (this.#native || !rest || !this.#started || !this.#signedIn)
      return Promise.resolve()
    // Only a check this session sent is shared: one left from an earlier
    // session (ended by Hermes, then signed in again) answers for that one.
    const out = this.#sessionCheck
    if (out?.run === this.#run) {
      if (cue) this.#sessionRecheck = true
      return out.done
    }
    const run = this.#run
    this.#sessionRecheck = false
    const check = {
      run,
      done: this.#askSession(rest, run).finally(() => {
        if (this.#sessionCheck !== check) return
        this.#sessionCheck = undefined
        if (this.#sessionRecheck && run === this.#run) {
          this.#sessionRecheck = false
          void this.#checkSession()
        }
      }),
    }
    this.#sessionCheck = check
    return check.done
  }

  async #askSession(rest: RestClient, run: number): Promise<void> {
    try {
      await rest.me()
    } catch (error) {
      const cause = asCindlError(error, 'auth.me')
      // Only the session it asked about: a stop() or another sign-in since
      // then started a new run, which this answer says nothing about.
      if (rest === this.#rest && this.#sessionEndedByHermes(cause, run))
        this.#sessionEnded(cause)
    }
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
      liveView: this.#screen !== undefined,
      ...(this.#configuredProfile || this.#servedProfile
        ? { soulProfile: 'named' as const }
        : this.#servedProfile === null
          ? { soulProfile: 'unnamed' as const }
          : {}),
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
        this.#forgetSession()
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
      this.#display.previous.set(
        sha256Hex(this.#display.viewerId).slice(0, 12),
        this.#display.viewerId,
      )
      delete this.#display.viewerId
      delete this.#display.viewerEpoch
      this.#screen?.leaseChanged()
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
    // Runs while signed in even with nothing tracked: an app-level prompt that
    // another surface starts reaches only that surface's socket, so only the
    // app-level list shows it here.
    if (!this.#started || !this.#signedIn || this.#requestSyncMs <= 0) return
    this.#requestSync = this.#deps.clock.setTimeout(() => {
      void this.#syncOpenRequests()
    }, this.#requestSyncMs)
  }

  async #syncOpenRequests(): Promise<void> {
    await this.#checkSession()
    if (!this.#started || !this.#signedIn) return
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
        // Every profile's screen changes reach every client (methods_display_watch.py:81-103).
        if (!this.#ownScreen(effect.status.profile_key)) return
        this.#takeDisplayStatus(effect.status)
        this.#screen?.leaseChanged()
        this.#emitDisplay()
        this.#refreshCapabilities()
        return
      case 'display-lease':
        // Lease changes fan out for every profile too (methods_display.py:38-47).
        if (!this.#ownScreen(effect.profileKey)) return
        this.#display.lease = effect.lease
        this.#screen?.leaseChanged()
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
    if (event.type === 'link.changed') this.#reported = true
    if (event.type === 'display.changed') this.#lastDisplay = event.display
    if (event.type === 'session.status') {
      const conversation = this.#conversations.get(event.conversationId)
      if (conversation && conversation.status !== event.status)
        this.#conversations.set(event.conversationId, {
          ...conversation,
          status: event.status,
        })
    }
    for (const listener of [...this.#listeners]) this.#deliver(listener, event)
  }

  #deliver(listener: (event: CindlEvent) => void, event: CindlEvent): void {
    try {
      listener(event)
    } catch (error) {
      this.#log.log('error', 'direct.listener-failed', {
        error: error instanceof Error ? error.name : 'unknown',
      })
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
        previous: new Set(this.#display.previous.keys()),
      },
      this.#now(),
    )
  }

  /**
   * Whether `viewerId` holds the lease as this connection's viewer, which is
   * what leaseHeldByThisDevice says. A view opened on an earlier connection
   * takes control again before it sends input.
   */
  /** The served profile's screen state from a display.status or display.observe answer. */
  #takeDisplayStatus(status: wire.DisplayStatus): void {
    this.#display.status = {
      supported: status.supported,
      installed: status.installed,
      running: status.running,
    }
    this.#display.lease = status.lease
    this.#display.profile = sha256Hex(status.profile_key)
    // The only answer that names the served profile; `custom` names none.
    const served = status.profile
    this.#servedProfile =
      served && served !== 'custom' && ProfileName.safeParse(served).success
        ? served
        : null
  }

  /** The profile SOUL.md routes name: the pinned one, else the one Hermes serves. */
  #soulProfile(): string {
    const name = this.#configuredProfile ?? this.#servedProfile
    if (!name)
      throw new CindlError(
        'unavailable',
        this.#servedProfile === null
          ? 'Hermes serves a home that no profile name addresses, so Cindl cannot name its SOUL.md.'
          : 'Hermes has not said which profile it serves yet.',
      )
    return name
  }

  /**
   * Whether a display event is about the screen this client shows. Until a
   * display.status answer names the served profile, none is.
   */
  #ownScreen(profileKey: string): boolean {
    return (
      this.#display.profile !== undefined &&
      sha256Hex(profileKey) === this.#display.profile
    )
  }

  #holdsLease(viewerId: string): boolean {
    const lease = this.#display.lease
    return (
      viewerId === this.#display.viewerId &&
      lease?.holder === 'human' &&
      lease.viewer_hash === sha256Hex(viewerId).slice(0, 12)
    )
  }

  /** display.observe on this connection: a ticket for the screen socket and a viewer id. */
  async #observeDisplay(
    viewerId?: string,
  ): Promise<{ ticket: string; path: string; viewerId: string }> {
    let result: unknown
    try {
      result = await this.#rpc('display.observe', viewerId ? { viewer_id: viewerId } : {})
    } catch (error) {
      // Hermes mints no ticket for a stopped screen and suggests display.start,
      // which Cindl never calls: say what is wrong instead.
      if (error instanceof CindlError && error.code === 'unavailable') {
        await this.#readDisplay().catch(() => undefined)
        if (this.#display.status?.running === false) throw screenStoppedError()
      }
      throw error
    }
    const observed = wire.parseWire(wire.DisplayObserveResult, result)
    if (!observed)
      throw new CindlError(
        'protocol',
        'Hermes answered in an unexpected format.',
        'display.observe',
      )
    this.#display.viewerId = observed.viewer_id
    this.#display.viewerEpoch = this.#epoch
    this.#takeDisplayStatus(observed)
    this.#emitDisplay()
    return { ticket: observed.ticket, path: observed.path, viewerId: observed.viewer_id }
  }

  #screenOrThrow(): LiveScreen {
    if (!this.#screen)
      throw new CindlError(
        'unsupported',
        'This client cannot open the screen socket, so it shows the screen state and who controls it, not the picture.',
      )
    return this.#screen
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
    const run = this.#run
    try {
      await this.#restOrThrow().learningGraph(this.#configuredProfile)
      this.#memoryProbe = 'responds'
    } catch (error) {
      const cause = asCindlError(error, 'learning graph')
      if (this.#sessionEndedByHermes(cause, run)) this.#sessionEnded(cause)
      if (cause.code !== 'not-found') return
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
    this.#takeDisplayStatus(status)
    this.#refreshCapabilities()
    return this.#emitDisplay()
  }

  // --- operations -----------------------------------------------------------------------

  readonly #handlers: { [K in OpName]: Handler<K> } = {
    'link.get': () => this.#link,
    'capabilities.get': () => this.#capabilities,
    'auth.signIn': async ({ origin }) => {
      // A working session (its link, tokens and connection) stays exactly as
      // it is until the new sign-in succeeds; a failed or cancelled one leaves
      // it usable. Without one, the attempt shows on the link and a failure
      // ends signed-out with the error.
      const keep = this.#signedIn
      const switching = origin !== this.#origin
      const parts = switching ? this.#parts(origin) : this.#currentParts()
      if (!keep) {
        if (switching) await this.#switchTo(parts)
        this.#started = true
        this.#setLink('connecting')
      }
      // From here this sign-in owns the client: a discovery still running
      // stops, and a stop() before it finishes keeps it from connecting.
      const run = ++this.#run
      this.#deps.clock.clearTimeout(this.#discoveryRetry)
      let status: wire.StatusResponse | undefined
      let failed: LinkPhase = 'signed-out'
      try {
        status = await parts.rest.status()
        if (status.auth_required === false) {
          failed = 'incompatible'
          throw new CindlError('unsupported', LOOPBACK_MODE)
        }
        if (parts.native) {
          if (!(status.auth_flows ?? []).includes('native_pkce'))
            throw new CindlError(
              'unsupported',
              'This Hermes server does not offer native sign-in (auth_flows has no native_pkce).',
            )
          if (!(await parts.native.identity())) {
            if (!this.#deps.authorizer)
              throw new CindlError(
                'unavailable',
                'This device cannot open the Hermes sign-in page.',
              )
            await parts.native.signIn(this.#deps.authorizer)
          }
        } else if (!(await this.#cookieSignedIn(parts.rest)))
          throw new CindlError(
            'unauthenticated',
            'Sign in on the Hermes login page, then try again.',
          )
      } catch (error) {
        const cause = asCindlError(error, 'auth.signIn')
        if (!keep) {
          if (status) this.#status = status
          this.#setLink(failed, cause)
          this.#refreshCapabilities()
        }
        throw cause
      }
      // stop() came in meanwhile: the sign-in stands, but nothing connects
      // until start(), which finds it again.
      const stopped = run !== this.#run
      if (keep && switching) await this.#switchTo(parts)
      this.#status = status
      if (stopped) return this.#link
      this.#started = true
      this.#signedIn = true
      this.#connect()
      return this.#link
    },
    'auth.signOut': async () => {
      this.stop()
      let hermesConfirmed: boolean | undefined
      if (this.#native) await this.#native.signOut()
      else hermesConfirmed = await this.#endCookieSession()
      this.#forgetSession()
      this.#setLink('signed-out')
      this.#refreshCapabilities()
      // Cookie mode says whether Hermes confirmed it, so the web can offer another try.
      return hermesConfirmed === undefined
        ? { localOnly: true as const }
        : { localOnly: true as const, hermesConfirmed }
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
    'soul.read': ({ profile }) => this.#readSoul(profile ?? this.#soulProfile()),
    'soul.write': async ({ profile, content, expectedVersion }) => {
      const name = profile ?? this.#soulProfile()
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
      memoryOverviewFrom(
        await this.#restOrThrow().memory(this.#configuredProfile),
        this.#now(),
      ),
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
    // No profile unless pinned: Hermes then uses the profile it serves.
    'memory.entries': () => this.#memoryEntries().list(this.#configuredProfile),
    'memory.read': ({ id }) => this.#memoryEntries().read(id, this.#configuredProfile),
    'memory.write': ({ id, content }) =>
      this.#memoryEntries().write(id, content, {
        confirm: true,
        ...(this.#configuredProfile ? { profile: this.#configuredProfile } : {}),
      }),
    'memory.delete': ({ id }) =>
      this.#memoryEntries().delete(id, {
        confirm: true,
        ...(this.#configuredProfile ? { profile: this.#configuredProfile } : {}),
      }),
    'display.status': () => this.#readDisplay(),
    // The live picture (ADR 0012). Never starts, stops or installs the screen.
    'display.watch': () => this.#screenOrThrow().watch(),
    'display.frame': ({ viewId }) => this.#screenOrThrow().frame(viewId),
    // Online, closing hands control back as closing Hermes's viewer window
    // does; with the link down it keeps the human's control, as a dropped
    // link would, instead of giving the screen to the agent unseen.
    'display.unwatch': ({ viewId }) =>
      this.#screen?.unwatch(viewId, this.#link.phase === 'online') ?? { stopped: false },
    'display.input': ({ viewId, events }) => this.#screenOrThrow().input(viewId, events),
    'display.acquireControl': async () => {
      // Control goes to the WATCHING viewer: Hermes passes input only from the
      // viewer id that holds the lease. A view opened on an earlier connection
      // opens again under an id this connection minted.
      if (this.#screen?.viewerId && this.#display.viewerEpoch !== this.#epoch)
        await this.#screen.rewatch()
      const viewerId =
        this.#screen?.viewerId ??
        (this.#display.viewerId && this.#display.viewerEpoch === this.#epoch
          ? this.#display.viewerId
          : (await this.#observeDisplay()).viewerId)
      const leased = wire.parseWire(
        wire.DisplayLeaseResult,
        await this.#rpc('display.lease.acquire', { viewer_id: viewerId }),
      )
      if (!leased)
        throw new CindlError(
          'protocol',
          'Hermes answered in an unexpected format.',
          'display.lease.acquire',
        )
      this.#display.lease = leased.lease
      this.#screen?.leaseChanged()
      return this.#emitDisplay()
    },
    'display.releaseControl': async () => {
      const current =
        this.#display.viewerEpoch === this.#epoch ? this.#display.viewerId : undefined
      const lease = this.#display.lease
      // A viewer id from an earlier connection cannot pass the minted-id check
      // any more, but `force` skips only that check: Hermes still releases
      // nothing another viewer holds (methods_display.py:247-261, lease.py:204-226).
      const earlier =
        lease?.holder === 'human' && lease.viewer_hash
          ? this.#display.previous.get(lease.viewer_hash)
          : undefined
      const params = earlier
        ? { viewer_id: earlier, force: true }
        : current
          ? { viewer_id: current }
          : undefined
      if (!params) return this.#displayState()
      const leased = wire.parseWire(
        wire.DisplayLeaseResult,
        await this.#rpc('display.lease.release', params),
      )
      if (!leased)
        throw new CindlError(
          'protocol',
          'Hermes answered in an unexpected format.',
          'display.lease.release',
        )
      this.#display.lease = leased.lease
      this.#screen?.leaseChanged()
      return this.#emitDisplay()
    },
  }

  /** Forget everything tied to the previous origin. */
  #reset(): void {
    this.#lastDisplay = undefined
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
    this.#display = { previous: new Map() }
    this.#servedProfile = undefined
    this.#screen?.close()
    this.#memoryProbe = undefined
    this.#normalizer = this.#newNormalizer()
  }
}
