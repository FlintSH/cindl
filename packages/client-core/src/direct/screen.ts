import {
  CindlError,
  type DisplayFrame,
  type DisplayInputEvent,
  type DisplayView,
} from '@cindl/contracts'
import { displayCloseCodes, wsPaths } from '@cindl/hermes-adapter'
import type { BinaryWebSocketFactory, BinaryWebSocketLike, Clock } from '../platform.ts'
import { createRfbClient, keysymForKey, type RfbClient, type RfbRegion } from '../rfb.ts'

/** How long `display.frame` waits for a change, and `display.watch` for the RFB handshake. */
const FRAME_WAIT_MS = 2_000
const READY_TIMEOUT_MS = 10_000
/**
 * A deliberate close. Hermes treats 1000 and 1001 from the viewer as closing
 * the window and hands control back if it held it (display.py:38, 192-196, 234-240).
 */
const CLOSE_DONE = 1000
/** Any other close keeps a lease this viewer holds, as a dropped link does (display.py:234-240). */
const CLOSE_KEEP_LEASE = 4100
/**
 * Liveness: after IDLE_PROBE_MS without a byte from the screen, ask for one
 * pixel. A non-incremental update request must be answered at once (RFC 6143
 * 7.5.3), so nothing within PROBE_ANSWER_MS more means the stream stalled.
 */
const IDLE_PROBE_MS = 15_000
const PROBE_ANSWER_MS = 10_000
/** FramebufferUpdateRequest, non-incremental, for the pixel at 0,0. */
const PIXEL_REQUEST = Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 1, 0, 1)

/** What `display.observe` gives a viewer (tui_gateway/methods_display.py). */
export interface ObservedScreen {
  ticket: string
  path: string
  viewerId: string
}

export interface LiveScreenOptions {
  factory: BinaryWebSocketFactory
  clock: Clock
  /** The Hermes origin (`https://…`); the screen socket is `wss://` on it. */
  origin(): string
  /**
   * `display.observe` on the current connection. Without a `viewerId` it keeps
   * the id this connection already minted, so a lease taken before watching
   * applies to the view.
   */
  observe(viewerId?: string): Promise<ObservedScreen>
  /** Whether this viewer holds the input lease on the current connection. */
  holdsLease(viewerId: string): boolean
  /**
   * Whether the screen runs now, by asking Hermes (display.status);
   * undefined when that cannot be read. Never rejects.
   */
  screenRunning(): Promise<boolean | undefined>
  newViewId(): string
  /** Redacted diagnostics: never frames, input or the ticket URL. */
  log(event: string, fields?: Record<string, unknown>): void
}

interface View {
  readonly viewId: string
  viewerId: string
  socket: BinaryWebSocketLike | undefined
  rfb: RfbClient | undefined
  size: { width: number; height: number } | undefined
  /** An update request is in flight. At most one is, so updates never pile up. */
  requested: boolean
  /** The server painted since this socket opened; until then the framebuffer is blank. */
  painted: boolean
  /** Why this view cannot show frames any more. */
  ended: CindlError | undefined
  /** Wakes a waiting `display.frame`. */
  wake: (() => void) | undefined
  /** Settles a handshake still in progress when the view ends. */
  abort: ((error: CindlError) => void) | undefined
  /** The liveness timer of the current socket. */
  idle: unknown
}

const closedError = () => new CindlError('not-found', 'That screen view was closed.')
const endedError = () =>
  new CindlError('unavailable', 'The screen connection ended. Watch the screen again.')

export const screenStoppedError = () =>
  new CindlError('unavailable', 'The agent screen is not running. Cindl never starts it.')

/**
 * The live picture of the agent-owned screen (ADR 0012). `display.observe`
 * gives a single-use ticket and a viewer id; the ticket opens
 * `/api/display/ws?display_ticket=…`, whose binary frames feed the shared RFB
 * client. The ticket and the RFB stream never leave this object. Input goes
 * only while this viewer holds the lease; Hermes filters it as well
 * (hermes_cli/web_routers/display.py:1-18, tools/bot_desktop/rfb_filter.py).
 */
export class LiveScreen {
  readonly #options: LiveScreenOptions
  #view: View | undefined
  /**
   * Watches run one at a time and a view that ends aborts its handshake, so
   * the only open socket is the current view's: ending it closes them all.
   */
  #queue: Promise<unknown> = Promise.resolve()
  /** Bumped by close(): a watch still waiting for its ticket then opens nothing. */
  #generation = 0

  constructor(options: LiveScreenOptions) {
    this.#options = options
  }

  /** The viewer id of the open view, for taking control as the WATCHING viewer. */
  get viewerId(): string | undefined {
    return this.#view && !this.#view.ended ? this.#view.viewerId : undefined
  }

  /** One view at a time: watching again replaces the view and keeps its viewer id. */
  watch(): Promise<DisplayView> {
    return this.#serial(() => this.#watch())
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #watch(): Promise<DisplayView> {
    const generation = this.#generation
    this.#end(CLOSE_KEEP_LEASE)
    const observed = await this.#options.observe()
    if (generation !== this.#generation) throw closedError()
    const view: View = {
      viewId: this.#options.newViewId(),
      viewerId: observed.viewerId,
      socket: undefined,
      rfb: undefined,
      size: undefined,
      requested: false,
      painted: false,
      ended: undefined,
      wake: undefined,
      abort: undefined,
      idle: undefined,
    }
    this.#view = view
    try {
      await this.#connect(view, observed)
    } catch (error) {
      if (this.#view === view) this.#view = undefined
      throw error
    }
    const size = view.size ?? { width: 1, height: 1 }
    return { viewId: view.viewId, width: size.width, height: size.height }
  }

  /** What changed since the last call, waiting briefly for a change. */
  async frame(viewId: string): Promise<DisplayFrame> {
    const view = this.#viewFor(viewId)
    if (!view.painted) {
      // A new or resized framebuffer is black until the server paints it:
      // wait for the picture, and show nothing rather than that.
      await this.#wait(view, FRAME_WAIT_MS)
      if (view.ended) throw view.ended
      if (!view.painted) return this.#frame(view, [])
    }
    let regions = view.rfb?.takeUpdate() ?? []
    if (regions.length === 0) {
      this.#request(view)
      await this.#wait(view, FRAME_WAIT_MS)
      if (view.ended) throw view.ended
      regions = view.rfb?.takeUpdate() ?? []
    }
    // The caller paints these, then asks again: the next change is already on its way.
    this.#request(view)
    return this.#frame(view, regions)
  }

  #frame(view: View, regions: readonly RfbRegion[]): DisplayFrame {
    const size = view.rfb?.size ?? view.size ?? { width: 1, height: 1 }
    return {
      viewId: view.viewId,
      width: size.width,
      height: size.height,
      regions: regions.map(({ x, y, width, height, rgba }) => ({
        x,
        y,
        width,
        height,
        rgba,
      })),
    }
  }

  /** Pointer and key input, only while this viewer holds the lease. Never logged. */
  input(viewId: string, events: readonly DisplayInputEvent[]): { sent: number } {
    const view = this.#viewFor(viewId)
    if (!this.#options.holdsLease(view.viewerId))
      throw new CindlError(
        'forbidden',
        'Take control of the screen first: input goes only while this device holds it.',
      )
    const rfb = view.rfb
    if (!rfb)
      throw new CindlError('unavailable', 'The screen is reconnecting. Try again.')
    rfb.setControlling(true)
    let sent = 0
    for (const event of events) {
      if (event.type === 'pointer') {
        if (rfb.pointer(event.x, event.y, event.buttons)) sent++
      } else {
        const keysym = keysymForKey(event.key)
        if (keysym !== undefined && rfb.key(keysym, event.down)) sent++
      }
    }
    return { sent }
  }

  /**
   * Stop showing the screen. With `handBack`, like closing Hermes's viewer
   * window, a lease this viewer holds returns to the agent; without it the
   * close reads as a dropped link and the human keeps control.
   */
  unwatch(viewId: string, handBack: boolean): { stopped: boolean } {
    if (this.#view?.viewId !== viewId) return { stopped: false }
    this.#end(handBack ? CLOSE_DONE : CLOSE_KEEP_LEASE)
    return { stopped: true }
  }

  /** The lease or the connection changed: input follows the lease. */
  leaseChanged(): void {
    const view = this.#view
    if (view?.rfb) view.rfb.setControlling(this.#options.holdsLease(view.viewerId))
  }

  /**
   * After the gateway connection changed, the view's viewer id cannot take
   * control (Hermes binds it to the connection that minted it). Open the view
   * again under an id this connection mints. The old socket closes without
   * handing control back, so a lease it held stays with the human until
   * `display.lease.acquire` moves it.
   */
  rewatch(): Promise<void> {
    return this.#serial(() => this.#rewatch())
  }

  async #rewatch(): Promise<void> {
    const view = this.#view
    if (!view) return
    try {
      const observed = await this.#options.observe()
      if (this.#view !== view) return
      view.viewerId = observed.viewerId
      this.#closeSocket(view, CLOSE_KEEP_LEASE)
      await this.#connect(view, observed)
    } catch (error) {
      if (this.#view === view && !view.socket) {
        view.ended =
          error instanceof CindlError && error.code === 'unavailable'
            ? error
            : endedError()
        view.wake?.()
      }
      throw error
    }
  }

  /** Sign-out, a new origin or stop(): close the view, handing control back, and cancel any watch. */
  close(): void {
    this.#generation++
    this.#end(CLOSE_DONE)
  }

  #end(code: number): void {
    const view = this.#view
    if (!view) return
    this.#view = undefined
    const why = closedError()
    view.ended = why
    this.#closeSocket(view, code)
    view.abort?.(why)
    view.wake?.()
  }

  #viewFor(viewId: string): View {
    const view = this.#view
    if (view?.viewId !== viewId)
      throw new CindlError(
        'not-found',
        'That screen view is not open. Watch the screen again.',
      )
    if (view.ended) throw view.ended
    return view
  }

  #request(view: View): void {
    if (view.requested || !view.rfb) return
    view.requested = true
    view.rfb.requestUpdate()
  }

  #closeSocket(view: View, code: number): void {
    const socket = view.socket
    view.socket = undefined
    this.#options.clock.clearTimeout(view.idle)
    view.rfb?.close()
    view.rfb = undefined
    view.requested = false
    try {
      socket?.close(code, code === CLOSE_DONE ? 'unwatch' : 'reconnect')
    } catch {
      // Already closed.
    }
  }

  /** Opens the screen socket and runs the RFB handshake, which asks for the whole screen. */
  #connect(view: View, observed: ObservedScreen): Promise<void> {
    // Only the pinned route on the Hermes origin ever receives the ticket.
    if (observed.path !== wsPaths.display)
      return Promise.reject(
        new CindlError(
          'protocol',
          'Hermes answered in an unexpected format.',
          'display.observe path',
        ),
      )
    const url = new URL(wsPaths.display, this.#options.origin())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('display_ticket', observed.ticket)
    const socket = this.#options.factory(url.toString())
    view.socket = socket
    view.painted = false
    view.ended = undefined
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let ready = false
      const timer = this.#options.clock.setTimeout(() => {
        if (settled) return
        this.#closeSocket(view, CLOSE_KEEP_LEASE)
        settle(new CindlError('timeout', 'The screen did not answer in time.'))
      }, READY_TIMEOUT_MS)
      const settle = (error?: CindlError): boolean => {
        if (settled) return false
        settled = true
        view.abort = undefined
        this.#options.clock.clearTimeout(timer)
        if (error) reject(error)
        else resolve()
        return true
      }
      view.abort = (error) => settle(error)
      const rfb = createRfbClient({
        send: (bytes) => {
          if (socket.readyState === 1) socket.send(bytes)
        },
        onReady: (size) => {
          view.size = size
          // The handshake ends with a request for the whole screen.
          view.requested = true
          ready = true
          settle()
        },
        onUpdate: () => {
          view.requested = false
          view.painted = true
          view.wake?.()
        },
        // The resized framebuffer is black until the rest of that update paints it.
        onResize: (size) => {
          view.size = size
          view.painted = false
        },
        onError: () => {
          this.#options.log('direct.screen-protocol-error')
          socket.close(CLOSE_KEEP_LEASE, 'protocol error')
        },
      })
      view.rfb = rfb
      rfb.setControlling(this.#options.holdsLease(view.viewerId))
      socket.onmessage = (event) => {
        if (view.socket !== socket) return
        rfb.receive(event.data)
        if (ready && view.socket === socket) this.#alive(view, socket)
      }
      socket.onerror = () => undefined
      socket.onclose = (event) => {
        if (view.socket !== socket) return
        view.socket = undefined
        this.#options.clock.clearTimeout(view.idle)
        view.rfb?.close()
        view.rfb = undefined
        view.requested = false
        const failed = settle(
          event.code === displayCloseCodes.screenStopped
            ? screenStoppedError()
            : new CindlError('unavailable', 'Hermes closed the screen connection.'),
        )
        if (!failed) this.#closed(view, event.code)
      }
    })
  }

  /** Bytes arrived: restart the quiet-spell timer that sends the one-pixel probe. */
  #alive(view: View, socket: BinaryWebSocketLike): void {
    const clock = this.#options.clock
    clock.clearTimeout(view.idle)
    view.idle = clock.setTimeout(() => {
      if (view.socket !== socket) return
      if (socket.readyState === 1) socket.send(PIXEL_REQUEST)
      view.idle = clock.setTimeout(() => this.#stalled(view, socket), PROBE_ANSWER_MS)
    }, IDLE_PROBE_MS)
  }

  /** Not even the probed pixel came: end the view, closing without handing control back. */
  #stalled(view: View, socket: BinaryWebSocketLike): void {
    if (view.socket !== socket) return
    this.#options.log('direct.screen-stalled')
    this.#closeSocket(view, CLOSE_KEEP_LEASE)
    if (this.#view !== view || view.ended) return
    view.ended = new CindlError(
      'unavailable',
      'The screen stopped answering. Watch the screen again.',
    )
    view.wake?.()
  }

  /** The screen socket closed after the view was up. */
  #closed(view: View, code: number): void {
    this.#options.log('direct.screen-closed', { code })
    if (this.#view !== view) return
    if (code === displayCloseCodes.evictedController) {
      // Another human took control: watch again with the same viewer id
      // (Hermes keeps an id this connection minted, methods_display.py:127-136).
      void this.#options
        .observe(view.viewerId)
        .then((observed) => {
          if (this.#view !== view) return
          view.viewerId = observed.viewerId
          return this.#connect(view, observed)
        })
        .catch((error: unknown) => {
          if (this.#view !== view) return
          view.ended =
            error instanceof CindlError && error.code === 'unavailable'
              ? error
              : endedError()
          view.wake?.()
        })
      return
    }
    // A screen that stops mid-view ends the RFB stream, and Hermes closes the
    // socket with a plain 1000 (display.py:181-185, 241-244); 4001 comes only
    // as a socket opens. Only the screen's status tells a stop from a dropped
    // link, so frames wait for that answer.
    void this.#options.screenRunning().then((running) => {
      if (this.#view !== view || view.ended) return
      view.ended = running === false ? screenStoppedError() : endedError()
      view.wake?.()
    })
  }

  #wait(view: View, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.#options.clock.setTimeout(done, ms)
      function done() {
        view.wake = undefined
        resolve()
      }
      view.wake = () => {
        this.#options.clock.clearTimeout(timer)
        done()
      }
    })
  }
}
