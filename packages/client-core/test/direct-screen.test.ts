import { CindlError, type DisplayFrame, type DisplayInputEvent } from '@cindl/contracts'
import {
  connectRawClient,
  nodeBinarySocketFactory,
  type DisplayViewer,
} from '@cindl/fixtures/fake-hermes'
import type { DiagnosticEntry } from '@cindl/hermes-adapter'
import { describe, expect, it, vi } from 'vitest'
import { LiveScreen, type ObservedScreen } from '../src/direct/screen.ts'
import {
  systemClock,
  type BinaryWebSocketFactory,
  type BinaryWebSocketLike,
  type Clock,
  type DirectClientDeps,
} from '../src/index.ts'
import { harness, type Harness } from './direct-harness.ts'

/** The synthetic screen (packages/fixtures/src/scenario/screen.ts). */
const SCREEN = { width: 640, height: 400 }
const BAR = [31, 42, 48]
const POINTER = [230, 120, 40]

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof CindlError ? error : undefined),
  )

const codeOf = async (promise: Promise<unknown>) =>
  (await failure(promise))?.code ?? 'resolved'

/** A client whose platform can open the screen socket; every URL it opens is kept. */
async function live(deps: Partial<DirectClientDeps> = {}) {
  const urls: string[] = []
  const base = nodeBinarySocketFactory()
  const displaySocketFactory: BinaryWebSocketFactory = (url) => {
    urls.push(url)
    return base(url)
  }
  const h = await harness({ deps: { displaySocketFactory, ...deps } })
  // Display operations wait for the screen probe, like any capability-gated call.
  await h.waitFor(() => viewState(h) === 'available')
  return { h, urls }
}

const viewers = (h: Harness): DisplayViewer[] => [...h.fake.gateway.displayViewers]

/** The colour at (x, y), from whichever region of the frame covers it. */
function pixel(frame: DisplayFrame, x: number, y: number): number[] | undefined {
  for (const region of frame.regions) {
    if (x < region.x || y < region.y) continue
    if (x >= region.x + region.width || y >= region.y + region.height) continue
    const at = ((y - region.y) * region.width + (x - region.x)) * 4
    return [...region.rgba.subarray(at, at + 3)]
  }
  return undefined
}

/** Pull frames, as a viewer that keeps painting does, until one shows `colour` at (x, y). */
async function frameShowing(
  h: Harness,
  viewId: string,
  at: { x: number; y: number },
  colour: number[],
): Promise<DisplayFrame> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const frame = await h.client.call('display.frame', { viewId })
    if (JSON.stringify(pixel(frame, at.x, at.y)) === JSON.stringify(colour)) return frame
  }
  throw new Error(`no frame showed ${colour.join(',')} at ${at.x},${at.y}`)
}

const pointer = (x: number, y: number): DisplayInputEvent => ({
  type: 'pointer',
  x,
  y,
  buttons: 0,
})

const viewState = (h: Harness) => h.store.getState().capabilities['computer.view']?.state

describe('direct client: live screen', () => {
  it('shows the picture only on a platform that can open the screen socket', async () => {
    const plain = await harness()
    await plain.waitFor(() => viewState(plain) === 'limited')
    expect(plain.store.getState().capabilities['computer.view']?.reason).toMatch(
      /cannot open the screen socket/,
    )
    expect(await codeOf(plain.client.call('display.watch', {}))).toBe('unsupported')
    expect(plain.rpcCalls('display.observe')).toBe(0)

    const { h } = await live()
    await h.waitFor(() => viewState(h) === 'available')
    expect(h.store.getState().capabilities['computer.view']?.source).toMatchObject({
      transport: 'rpc',
      endpoint: 'display.observe → /api/display/ws',
    })
  })

  it('watches the screen and pulls the whole picture, then only what changed', async () => {
    const { h, urls } = await live()
    const view = await h.client.call('display.watch', {})
    expect(view).toMatchObject(SCREEN)
    expect(view.viewId).toMatch(/^view-[a-z0-9]{8,32}$/)
    // One socket, to the pinned route on the Hermes origin, with a fresh ticket.
    expect(urls).toHaveLength(1)
    const url = new URL(urls[0] ?? '')
    expect(`${url.protocol}//${url.host}`).toBe(h.fake.origin.replace('http', 'ws'))
    expect(url.pathname).toBe('/api/display/ws')
    expect(url.searchParams.get('display_ticket')).toBeTruthy()
    expect(viewers(h)).toHaveLength(1)

    const first = await h.client.call('display.frame', { viewId: view.viewId })
    expect(first).toMatchObject({ viewId: view.viewId, ...SCREEN })
    const covered = first.regions.reduce((sum, r) => sum + r.width * r.height, 0)
    expect(covered).toBeGreaterThanOrEqual(SCREEN.width * SCREEN.height)
    expect(pixel(first, 0, 0)).toEqual(BAR)

    // The synthetic progress bar moves on every update request.
    const next = await h.client.call('display.frame', { viewId: view.viewId })
    expect(next.regions.length).toBeGreaterThan(0)
    for (const region of next.regions)
      expect(region.width * region.height).toBeLessThan(SCREEN.width * SCREEN.height)
    // Viewing never starts, stops or installs the screen.
    expect(h.fake.calls.some((c) => /display\.(start|stop|install)/.test(c.name))).toBe(
      false,
    )
  })

  it('sends input only after taking control as the watching viewer', async () => {
    const { h } = await live()
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.frame', { viewId })
    const [viewer] = viewers(h)
    expect(viewer).toBeDefined()

    expect(
      await codeOf(
        h.client.call('display.input', { viewId, events: [pointer(200, 150)] }),
      ),
    ).toBe('forbidden')
    // Refused on this device: nothing reached Hermes's input gate.
    expect(viewer?.filter.passedInput).toBe(0)
    expect(viewer?.filter.droppedInput).toBe(0)

    const held = await h.client.call('display.acquireControl', { confirm: true })
    expect(held).toMatchObject({ controller: 'you', leaseHeldByThisDevice: true })
    // The lease names the viewer whose socket shows the screen, so Hermes passes its input.
    expect(h.fake.store.display.holderViewerId).toBe(viewer?.viewerId)
    expect(h.rpcCalls('display.observe')).toBe(1)

    const sent = await h.client.call('display.input', {
      viewId,
      events: [
        pointer(200, 150),
        { type: 'key', key: 'a', down: true },
        { type: 'key', key: 'a', down: false },
      ],
    })
    expect(sent).toEqual({ sent: 3 })
    await h.waitFor(() => viewer?.filter.passedInput === 3)
    expect(viewer?.filter.droppedInput).toBe(0)
    await frameShowing(h, viewId, { x: 200, y: 150 }, POINTER)
  })

  it('keeps a lease taken before watching for the view', async () => {
    const { h } = await live()
    await h.client.call('display.acquireControl', { confirm: true })
    const holder = h.fake.store.display.holderViewerId
    const { viewId } = await h.client.call('display.watch', {})
    expect(viewers(h).map((v) => v.viewerId)).toEqual([holder])
    expect(
      await h.client.call('display.input', { viewId, events: [pointer(10, 10)] }),
    ).toEqual({ sent: 1 })
  })

  it('watches again after another viewer takes control', async () => {
    const { h } = await live()
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.acquireControl', { confirm: true })
    const [mine] = viewers(h)
    const other = await connectRawClient(h.fake, h.fake.signIn())
    const observed = (await other.request('display.observe', {})) as {
      result: { viewer_id: string }
    }
    const observes = h.rpcCalls('display.observe')
    await other.request('display.lease.acquire', { viewer_id: observed.result.viewer_id })

    // Hermes evicts the former holder with 4000; the view comes back in watch mode.
    await h.waitFor(() => mine?.closedWith === 4000)
    const again = await h.waitFor(() =>
      viewers(h).find((v) => v !== mine && v.viewerId === mine?.viewerId),
    )
    expect(h.rpcCalls('display.observe')).toBe(observes + 1)
    await h.waitFor(() => h.store.getState().display?.controller === 'another-viewer')
    expect(
      await codeOf(h.client.call('display.input', { viewId, events: [pointer(5, 5)] })),
    ).toBe('forbidden')
    const frame = await h.client.call('display.frame', { viewId })
    expect(frame.regions.length).toBeGreaterThan(0)
    expect(again.filter.passedInput).toBe(0)
    other.close()
  })

  it('says unavailable for a stopped screen and never starts it', async () => {
    const { h, urls } = await live()
    h.fake.store.display.running = false
    const refused = await failure(h.client.call('display.watch', {}))
    expect(refused?.code).toBe('unavailable')
    expect(refused?.message).toMatch(/not running\. Cindl never starts it/)
    expect(urls).toHaveLength(0)
    await h.waitFor(() => viewState(h) === 'unavailable')

    // Hermes announces a screen started elsewhere; only then does Cindl watch again.
    h.fake.gateway.startScreen()
    await h.waitFor(() => viewState(h) === 'available')
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.frame', { viewId })
    h.fake.gateway.stopScreen()
    // The view keeps pulling, as a painting viewer does, until the close lands.
    const ended = await failure(
      (async () => {
        for (let pull = 0; pull < 20; pull++)
          await h.client.call('display.frame', { viewId })
      })(),
    )
    expect(ended?.code).toBe('unavailable')
    expect(ended?.message).toMatch(/not running/)
    expect(h.fake.calls.some((c) => /display\.(start|stop|install)/.test(c.name))).toBe(
      false,
    )
  })

  it('hands control back when the view stops, like closing the viewer window', async () => {
    const { h } = await live()
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.acquireControl', { confirm: true })
    const [viewer] = viewers(h)
    expect(await h.client.call('display.unwatch', { viewId })).toEqual({ stopped: true })
    await h.waitFor(() => viewer?.closedWith === 1000)
    await h.waitFor(() => h.fake.store.display.holder === 'agent')
    expect(await codeOf(h.client.call('display.frame', { viewId }))).toBe('not-found')
    expect(await h.client.call('display.unwatch', { viewId })).toEqual({ stopped: false })
  })

  it('stops the view while the link is down without handing the screen to the agent', async () => {
    const { h } = await live()
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.frame', { viewId })
    await h.client.call('display.acquireControl', { confirm: true })
    const [viewer] = viewers(h)
    // The gateway link drops and stays down; the screen socket is still up.
    h.fake.gateway.frozen = true
    h.fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    expect(viewState(h)).not.toBe('available')
    expect(await h.client.call('display.unwatch', { viewId })).toEqual({ stopped: true })
    await h.waitFor(() => viewer?.closedWith !== undefined)
    expect(viewer?.closedWith).toBe(4100)
    expect(h.fake.store.display.holder).toBe('human')
    h.fake.gateway.frozen = false
  })

  it('takes control again under a new viewer id after a reconnect, keeping the human in control meanwhile', async () => {
    const { h } = await live()
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.acquireControl', { confirm: true })
    const [before] = viewers(h)
    const holder = h.fake.store.display.holderViewerId

    h.fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.connectionEpoch >= 2)
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    // The old viewer id cannot take or return control on this connection, so
    // input waits; the screen stays the human's (display.py:234-240).
    expect(
      await codeOf(h.client.call('display.input', { viewId, events: [pointer(5, 5)] })),
    ).toBe('forbidden')
    expect(h.fake.store.display.holderViewerId).toBe(holder)

    await h.client.call('display.acquireControl', { confirm: true })
    const after = viewers(h).find((v) => v !== before)
    expect(after?.viewerId).toBeDefined()
    expect(after?.viewerId).not.toBe(holder)
    expect(h.fake.store.display.holderViewerId).toBe(after?.viewerId)
    // The old socket closed without a hand-back, so the agent never got the screen in between.
    expect(before?.closedWith).toBeDefined()
    expect([1000, 1001]).not.toContain(before?.closedWith)
    expect(
      await h.client.call('display.input', { viewId, events: [pointer(5, 5)] }),
    ).toEqual({ sent: 1 })
    expect(
      (await h.client.call('display.frame', { viewId })).regions.length,
    ).toBeGreaterThan(0)
  })

  it('ends the view when it cannot open again after a reconnect', async () => {
    const { h } = await live()
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.frame', { viewId })
    h.fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.connectionEpoch >= 2)
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    // The screen stops between the new ticket and the new socket, so the
    // reopened socket is refused (4001) after the old one closed.
    h.fake.gateway.afterHandle = (method) => {
      if (method === 'display.observe') h.fake.store.display.running = false
    }
    const refused = await failure(
      h.client.call('display.acquireControl', { confirm: true }),
    )
    expect(refused?.message).toMatch(/not running/)
    expect(h.fake.store.display.holder).toBe('agent')
    const ended = await failure(h.client.call('display.frame', { viewId }))
    expect(ended?.code).toBe('unavailable')
    expect(ended?.message).toMatch(/not running/)
  })

  it('keeps one screen socket when two watches race, and only the last view', async () => {
    const { h } = await live()
    const [first, second] = await Promise.all([
      h.client.call('display.watch', {}),
      h.client.call('display.watch', {}),
    ])
    expect(first.viewId).not.toBe(second.viewId)
    await h.waitFor(() => viewers(h).length === 1)
    expect(await codeOf(h.client.call('display.frame', { viewId: first.viewId }))).toBe(
      'not-found',
    )
    const frame = await h.client.call('display.frame', { viewId: second.viewId })
    expect(frame.regions.length).toBeGreaterThan(0)
    await h.client.call('display.unwatch', { viewId: second.viewId })
    await h.waitFor(() => viewers(h).length === 0)
  })

  it('ignores screen events for another Hermes profile', async () => {
    const { h } = await live()
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.frame', { viewId })
    await h.client.call('display.acquireControl', { confirm: true })
    // Hermes fans every profile's display events out to every client.
    h.fake.gateway.otherProfileDisplay({ running: false, holder: 'agent' })
    h.fake.gateway.otherProfileDisplay({ running: true, holder: 'human' })
    // A gateway round trip after the broadcasts: they have been handled.
    await h.client.call('routines.list', {})
    expect(h.store.getState().display).toMatchObject({
      status: 'running',
      controller: 'you',
      leaseHeldByThisDevice: true,
    })
    expect(viewState(h)).toBe('available')
    expect(
      await h.client.call('display.input', { viewId, events: [pointer(5, 5)] }),
    ).toEqual({ sent: 1 })
    // This profile's own events still apply.
    h.fake.gateway.stopScreen()
    await h.waitFor(() => viewState(h) === 'unavailable')
  })

  it('never logs the ticket, the screen URL, frames or input', async () => {
    const logs: DiagnosticEntry[] = []
    const { h, urls } = await live({ log: (entry) => logs.push(entry) })
    const { viewId } = await h.client.call('display.watch', {})
    await h.client.call('display.frame', { viewId })
    await h.client.call('display.acquireControl', { confirm: true })
    await h.client.call('display.input', {
      viewId,
      events: [{ type: 'key', key: 's', down: true }],
    })
    h.fake.gateway.stopScreen()
    await h.waitFor(() => logs.some((l) => l.event === 'direct.screen-closed'))
    expect(logs.find((l) => l.event === 'direct.screen-closed')?.detail).toEqual({
      code: 1000,
    })
    const ticket = new URL(urls[0] ?? '').searchParams.get('display_ticket') ?? ''
    expect(ticket).not.toBe('')
    const text = JSON.stringify([logs, h.events])
    expect(text).not.toContain(ticket)
    expect(text).not.toContain('display_ticket')
    expect(text).not.toContain('/api/display/ws?')
    expect(text).not.toContain('rgba')
  })
})

/** A stub screen socket: records what LiveScreen sends and how it closes it. */
interface StubSocket extends BinaryWebSocketLike {
  readonly sent: Uint8Array[]
  readonly closes: Array<[number | undefined, string | undefined]>
  /** Server bytes, as if they arrived on the socket. */
  feed(bytes: ArrayLike<number>): void
  /** Hermes closes the socket. */
  drop(code: number): void
}

/** A clock whose timers fire only when the test says so. */
function manualClock(): Clock & { fire(): void } {
  const timers = new Map<number, () => void>()
  let next = 0
  return {
    now: () => Date.now(),
    setTimeout(callback) {
      next += 1
      timers.set(next, callback)
      return next
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    fire() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id)
        callback()
      }
    },
  }
}

/** A LiveScreen over stub sockets; `observe` defaults to an immediate ticket. */
function stubScreen(
  options: {
    path?: string
    observe?: () => Promise<ObservedScreen>
    clock?: Clock
    screenRunning?: () => Promise<boolean | undefined>
  } = {},
) {
  const opened: string[] = []
  const sockets: StubSocket[] = []
  const logs: string[] = []
  const live = new LiveScreen({
    factory: (url) => {
      opened.push(url)
      const socket: StubSocket = {
        readyState: 1,
        sent: [],
        closes: [],
        send(data) {
          this.sent.push(data)
        },
        close(code, reason) {
          this.closes.push([code, reason])
        },
        feed(bytes) {
          this.onmessage?.({ data: Uint8Array.from(bytes) })
        },
        drop(code) {
          this.onclose?.({ code, reason: '' })
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      }
      sockets.push(socket)
      return socket
    },
    clock: options.clock ?? systemClock,
    origin: () => 'https://hermes.example.test',
    observe:
      options.observe ??
      (() =>
        Promise.resolve({
          ticket: 'fixture-ticket',
          path: options.path ?? '/api/display/ws',
          viewerId: 'fixture-viewer',
        })),
    holdsLease: () => false,
    screenRunning: options.screenRunning ?? (() => Promise.resolve(true)),
    newViewId: () => 'view-fixture01',
    log: (event) => logs.push(event),
  })
  return { live, opened, sockets, logs }
}

/** The server side of the RFB 3.8 handshake (security None) for a `width` x `height` screen. */
function serverHandshake(socket: StubSocket, width = 64, height = 32): void {
  socket.feed([...'RFB 003.008\n'].map((c) => c.charCodeAt(0)))
  socket.feed([1, 1]) // one security type: None
  socket.feed([0, 0, 0, 0]) // SecurityResult OK
  const init = new Uint8Array(24)
  init[0] = width >> 8
  init[1] = width & 0xff
  init[2] = height >> 8
  init[3] = height & 0xff
  socket.feed(init) // ServerInit, empty name
}

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const s32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]
/** A FramebufferUpdate header for `count` rectangles. */
const updateHeader = (count: number) => [0, 0, ...u16(count)]
/** A Raw rectangle of one colour, in the client's pixel format (R, G, B, unused). */
const rawRect = (
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly number[],
) => [
  ...u16(rect.x),
  ...u16(rect.y),
  ...u16(rect.width),
  ...u16(rect.height),
  ...s32(0),
  ...Array.from({ length: rect.width * rect.height }, () => [...colour, 0]).flat(),
]
/** The DesktopSize pseudo-rectangle (encoding -223). */
const desktopSize = (width: number, height: number) => [
  ...u16(0),
  ...u16(0),
  ...u16(width),
  ...u16(height),
  ...s32(-223),
]

/** Watch a stub screen through the handshake; returns the view and its socket. */
async function watchedStub(
  clock: Clock,
  screenRunning?: () => Promise<boolean | undefined>,
) {
  const stub = stubScreen({ clock, ...(screenRunning ? { screenRunning } : {}) })
  const watching = stub.live.watch()
  await vi.waitFor(() => expect(stub.sockets).toHaveLength(1))
  const socket = stub.sockets[0] as StubSocket
  serverHandshake(socket, 4, 2)
  const { viewId } = await watching
  return { ...stub, socket, viewId }
}

describe('live screen: frames', () => {
  it('shows nothing until the screen first paints, never the blank framebuffer', async () => {
    const clock = manualClock()
    const { live, socket, viewId } = await watchedStub(clock)
    // The first update is slow: the wait ends before any paint.
    const waiting = live.frame(viewId)
    clock.fire()
    expect((await waiting).regions).toEqual([])
    socket.feed([
      ...updateHeader(1),
      ...rawRect({ x: 1, y: 0, width: 1, height: 1 }, [10, 20, 30]),
    ])
    expect(pixel(await live.frame(viewId), 1, 0)).toEqual([10, 20, 30])
  })

  it('shows nothing between a resize and the paint that follows it', async () => {
    const clock = manualClock()
    const { live, socket, viewId } = await watchedStub(clock)
    socket.feed([
      ...updateHeader(1),
      ...rawRect({ x: 0, y: 0, width: 4, height: 2 }, [1, 2, 3]),
    ])
    expect(pixel(await live.frame(viewId), 0, 0)).toEqual([1, 2, 3])
    // DesktopSize arrives in one message, the repaint in the next.
    socket.feed([...updateHeader(2), ...desktopSize(6, 2)])
    const waiting = live.frame(viewId)
    clock.fire()
    expect((await waiting).regions).toEqual([])
    socket.feed(rawRect({ x: 0, y: 0, width: 6, height: 2 }, [4, 5, 6]))
    const repainted = await live.frame(viewId)
    expect(repainted).toMatchObject({ width: 6, height: 2 })
    expect(pixel(repainted, 5, 1)).toEqual([4, 5, 6])
  })
})

describe('live screen: when Hermes closes the view', () => {
  it('waits for the screen status and ends a stopped screen as not running', async () => {
    let answer: (running: boolean | undefined) => void = () => undefined
    const { live, socket, viewId } = await watchedStub(
      systemClock,
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    socket.feed([
      ...updateHeader(1),
      ...rawRect({ x: 0, y: 0, width: 4, height: 2 }, [1, 2, 3]),
    ])
    await live.frame(viewId)
    // A screen that stops mid-view ends with a plain 1000 (display.py:181-185, 241-244).
    socket.drop(1000)
    const pulling = failure(live.frame(viewId))
    answer(false)
    const ended = await pulling
    expect(ended?.code).toBe('unavailable')
    expect(ended?.message).toMatch(/not running/)
  })

  it('calls the view ended, not the screen stopped, while the screen still runs', async () => {
    const { live, socket, viewId } = await watchedStub(systemClock, () =>
      Promise.resolve(true),
    )
    socket.drop(1000)
    const ended = await failure(live.frame(viewId))
    expect(ended?.code).toBe('unavailable')
    expect(ended?.message).toMatch(/connection ended/)
  })
})

describe('live screen: closes that keep the human in control', () => {
  it('closes with 4100 when the handshake stalls, never handing control back', async () => {
    const clock = manualClock()
    const { live, sockets } = stubScreen({ clock })
    const watching = live.watch()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    clock.fire()
    expect(await codeOf(watching)).toBe('timeout')
    expect(sockets[0]?.closes).toEqual([[4100, 'reconnect']])
  })

  it('closes with 4100 on a malformed RFB stream, never handing control back', async () => {
    const { live, socket, viewId, logs } = await watchedStub(systemClock)
    // A server message type RFB 3.8 does not define.
    socket.feed([200])
    expect(socket.closes).toEqual([[4100, 'protocol error']])
    expect(logs).toContain('direct.screen-protocol-error')
    socket.drop(4100)
    expect(await codeOf(live.frame(viewId))).toBe('unavailable')
  })
})

describe('live screen: liveness', () => {
  it('asks for one pixel after a quiet spell and ends a stream that stays silent', async () => {
    const clock = manualClock()
    const { live, socket, viewId, logs } = await watchedStub(clock)
    socket.sent.length = 0
    clock.fire()
    expect(socket.sent).toEqual([Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 1, 0, 1)])
    clock.fire()
    expect(socket.closes).toEqual([[4100, 'reconnect']])
    expect(logs).toContain('direct.screen-stalled')
    const ended = await failure(live.frame(viewId))
    expect(ended?.code).toBe('unavailable')
    expect(ended?.message).toMatch(/stopped answering/)
  })

  it('keeps a stream that answers the probe', async () => {
    const clock = manualClock()
    const { live, socket, viewId } = await watchedStub(clock)
    clock.fire()
    socket.feed([
      ...updateHeader(1),
      ...rawRect({ x: 0, y: 0, width: 1, height: 1 }, [9, 9, 9]),
    ])
    // The answer restarted the quiet-spell timer: this is a new probe, not a stall.
    clock.fire()
    expect(socket.closes).toEqual([])
    expect(pixel(await live.frame(viewId), 0, 0)).toEqual([9, 9, 9])
  })
})

describe('live screen: the ticket', () => {
  it('sends it only to the pinned route on the Hermes origin, over wss', async () => {
    const { live, opened, sockets } = stubScreen()
    const watching = live.watch()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    // Hermes refuses a spent ticket with 4401.
    sockets[0]?.drop(4401)
    expect(await codeOf(watching)).toBe('unavailable')
    expect(opened).toEqual([
      'wss://hermes.example.test/api/display/ws?display_ticket=fixture-ticket',
    ])
  })

  it('refuses a path Hermes v0.22.5 never returns, without opening anything', async () => {
    const { live, opened } = stubScreen({
      path: 'wss://elsewhere.invalid/api/display/ws',
    })
    expect(await codeOf(live.watch())).toBe('protocol')
    expect(opened).toEqual([])
  })
})

describe('live screen: closing', () => {
  it('closes a socket still in its handshake at once and settles the watch', async () => {
    const { live, sockets } = stubScreen()
    const watching = live.watch()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const started = Date.now()
    live.close()
    expect(await codeOf(watching)).toBe('not-found')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(sockets[0]?.closes).toEqual([[1000, 'unwatch']])
  })

  it('opens nothing for a watch still waiting for its ticket when the screen closes', async () => {
    let answer: (observed: ObservedScreen) => void = () => undefined
    const { live, opened } = stubScreen({
      observe: () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    })
    const watching = live.watch()
    await vi.waitFor(() => expect(answer).not.toBe(undefined))
    live.close()
    answer({
      ticket: 'fixture-ticket',
      path: '/api/display/ws',
      viewerId: 'fixture-viewer',
    })
    expect(await codeOf(watching)).toBe('not-found')
    expect(opened).toEqual([])
  })
})
