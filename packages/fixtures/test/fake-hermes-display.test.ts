import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  closeFakes,
  connectRawClient,
  RfbClientFilter,
  startFakeHermes,
  type FakeHermes,
} from '../src/fake-hermes/index.ts'

const fakes: FakeHermes[] = []
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close()
})
async function fake() {
  const started = await startFakeHermes()
  fakes.push(started)
  return started
}

async function until(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 5_000) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))

/** Version (12 bytes), security type None (1), ClientInit shared (1). */
const HANDSHAKE = new Uint8Array(14)
const UPDATE_REQUEST = Uint8Array.of(3, 1, 0, 0, 0, 0, 2, 128, 1, 144)
const KEY = Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0x61)
const POINTER = Uint8Array.of(5, 0, 0, 10, 0, 10)

describe('fake Hermes: RFB input gate (rfb_filter.py)', () => {
  it('passes the handshake and update requests, and input only while allowed', () => {
    let allowed = false
    const filter = new RfbClientFilter(() => allowed)
    // The handshake passes, with ClientInit's shared flag forced on.
    expect(filter.feed(HANDSHAKE)).toEqual(join(HANDSHAKE.slice(0, 13), Uint8Array.of(1)))
    expect(filter.feed(join(UPDATE_REQUEST, KEY, POINTER))).toEqual(UPDATE_REQUEST)
    expect(filter.droppedInput).toBe(2)
    allowed = true
    expect(filter.feed(join(KEY, POINTER))).toEqual(join(KEY, POINTER))
    expect(filter.passedInput).toBe(2)
  })

  it('reassembles messages split across WebSocket frames', () => {
    const filter = new RfbClientFilter(() => true)
    filter.feed(HANDSHAKE)
    const encodings = Uint8Array.of(2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1)
    expect(filter.feed(encodings.subarray(0, 3))).toHaveLength(0)
    expect(filter.feed(encodings.subarray(3))).toEqual(encodings)
    const cutText = Uint8Array.of(6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69)
    expect(filter.feed(cutText.subarray(0, 9))).toHaveLength(0)
    expect(filter.feed(cutText.subarray(9))).toEqual(cutText)
    expect(filter.passedInput).toBe(1)
  })

  it('refuses an unknown client message', () => {
    const filter = new RfbClientFilter(() => true)
    filter.feed(HANDSHAKE)
    expect(() => filter.feed(Uint8Array.of(9))).toThrow(/unknown RFB client message/)
  })
})

describe('fake Hermes: the rest of the RFB gate (rfb_filter.py:20-39, 61-64)', () => {
  const QEMU_KEY = Uint8Array.of(255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 30)
  const SET_DESKTOP_SIZE = Uint8Array.from([
    251,
    0,
    0,
    64,
    0,
    32,
    1,
    0,
    ...new Array<number>(16).fill(0),
  ])
  const CONTINUOUS_UPDATES = Uint8Array.of(150, 1, 0, 0, 0, 0, 0, 64, 0, 32)
  const FENCE = Uint8Array.of(248, 0, 0, 0, 0, 0, 0, 0, 2, 7, 7)

  it('gates QEMU key events and SetDesktopSize like input, and frames the rest', () => {
    let allowed = false
    const filter = new RfbClientFilter(() => allowed)
    filter.feed(HANDSHAKE)
    expect(
      filter.feed(join(QEMU_KEY, SET_DESKTOP_SIZE, CONTINUOUS_UPDATES, FENCE)),
    ).toEqual(join(CONTINUOUS_UPDATES, FENCE))
    expect(filter.droppedInput).toBe(2)
    allowed = true
    expect(filter.feed(join(QEMU_KEY, SET_DESKTOP_SIZE))).toEqual(
      join(QEMU_KEY, SET_DESKTOP_SIZE),
    )
  })

  it('forces the shared flag on, so a viewer never disconnects the others', () => {
    const filter = new RfbClientFilter(() => true)
    const exclusive = new Uint8Array(14) // ClientInit shared flag 0
    const passed = filter.feed(exclusive)
    expect(passed[13]).toBe(1)
  })

  it('refuses clipboard text past 256 KiB, even as an extended (negative) length', () => {
    const header = (length: number) => {
      const bytes = new Uint8Array(8)
      bytes[0] = 6
      new DataView(bytes.buffer).setInt32(4, length)
      return bytes
    }
    const extended = new RfbClientFilter(() => true)
    extended.feed(HANDSHAKE)
    expect(extended.feed(join(header(-3), Uint8Array.of(1, 2, 3)))).toHaveLength(11)
    const huge = new RfbClientFilter(() => true)
    huge.feed(HANDSHAKE)
    expect(() => huge.feed(header(256 * 1024 + 1))).toThrow(/too large/)
  })
})

describe('fake Hermes: screen viewers (display.py)', () => {
  it('hands control back on a clean close and keeps it on a dropped link', async () => {
    const f = await fake()
    const client = await connectRawClient(f, f.signIn())
    const observe = async (viewerId?: string) =>
      (
        (await client.request(
          'display.observe',
          viewerId ? { viewer_id: viewerId } : {},
        )) as { result: { ticket: string; viewer_id: string } }
      ).result
    const open = (ticket: string) =>
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(
          `${f.origin.replace('http', 'ws')}/api/display/ws?display_ticket=${ticket}`,
        )
        // The screen speaks first: its RFB version.
        ws.once('message', () => resolve(ws))
      })

    const first = await observe()
    const closing = await open(first.ticket)
    await client.request('display.lease.acquire', { viewer_id: first.viewer_id })
    expect(f.store.display.holderViewerId).toBe(first.viewer_id)
    closing.close(1000)
    await until(() => f.store.display.holder === 'agent')

    // The same connection keeps its viewer id; a dropped link keeps the human's control.
    const second = await observe(first.viewer_id)
    expect(second.viewer_id).toBe(first.viewer_id)
    const dropping = await open(second.ticket)
    await client.request('display.lease.acquire', { viewer_id: second.viewer_id })
    dropping.terminate()
    await until(() => f.gateway.displayViewers.size === 0)
    expect(f.store.display.holderViewerId).toBe(second.viewer_id)
    client.close()
  })
})

describe('fake Hermes: a screen that stops mid-view (display.py:181-185, 241-244)', () => {
  it('closes each viewer with 1000 and keeps the human in control', async () => {
    const f = await fake()
    const client = await connectRawClient(f, f.signIn())
    const observed = (
      (await client.request('display.observe', {})) as {
        result: { ticket: string; viewer_id: string }
      }
    ).result
    const ws = await new Promise<WebSocket>((resolve) => {
      const socket = new WebSocket(
        `${f.origin.replace('http', 'ws')}/api/display/ws?display_ticket=${observed.ticket}`,
      )
      socket.once('message', () => resolve(socket))
    })
    await client.request('display.lease.acquire', { viewer_id: observed.viewer_id })
    const closed = new Promise<number>((resolve) =>
      ws.once('close', (code) => resolve(code)),
    )
    f.gateway.stopScreen()
    expect(await closed).toBe(1000)
    await until(() => f.gateway.displayViewers.size === 0)
    // Hermes closed it, so this is no hand-back by the viewer.
    expect(f.store.display.holderViewerId).toBe(observed.viewer_id)
    client.close()
  })
})

describe('fake Hermes: closing fakes in tests', () => {
  it('closes every fake before it reports a contract violation', async () => {
    const first = await startFakeHermes()
    const second = await startFakeHermes()
    first.violations.push('synthetic violation (fixture)')
    await expect(closeFakes([first, second])).rejects.toThrow(/synthetic violation/)
    // Neither is left listening, the one after the violation included.
    for (const closed of [first, second])
      await expect(fetch(`${closed.origin}/api/status`)).rejects.toThrow()
  })
})
