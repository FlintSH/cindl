import { CindlError } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { createRfbClient, keysymForKey, RFB_MAX_SIDE } from '../src/rfb.ts'

// A byte-level stand-in for Hermes's /api/display/ws (raw RFB from Xvnc).
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]
const VERSION = ascii('RFB 003.008\n')
const NONE_ONLY = Uint8Array.of(1, 1)
const SECURITY_OK = Uint8Array.of(...u32(0))
/** Xvnc's default desktop name carries the host and user name. */
const DESKTOP_NAME = 'studio-host.invalid:1 (owner)'
const serverInit = (width: number, height: number) =>
  Uint8Array.of(
    ...u16(width),
    ...u16(height),
    ...new Array<number>(16).fill(0),
    ...u32(DESKTOP_NAME.length),
    ...ascii(DESKTOP_NAME),
  )
type Pixel = [number, number, number]
const raw = (x: number, y: number, w: number, h: number, pixels: Pixel[]) => [
  ...u16(x),
  ...u16(y),
  ...u16(w),
  ...u16(h),
  ...u32(0),
  ...pixels.flatMap(([r, g, b]) => [r, g, b, 0]),
]
const copy = (x: number, y: number, w: number, h: number, sx: number, sy: number) => [
  ...u16(x),
  ...u16(y),
  ...u16(w),
  ...u16(h),
  ...u32(1),
  ...u16(sx),
  ...u16(sy),
]
const desktopSize = (w: number, h: number) => [
  ...u16(0),
  ...u16(0),
  ...u16(w),
  ...u16(h),
  ...u32(-223 >>> 0),
]
const update = (...rects: number[][]) =>
  Uint8Array.of(0, 0, ...u16(rects.length), ...rects.flat())

function session() {
  const sent: Uint8Array[] = []
  const errors: CindlError[] = []
  const events: string[] = []
  const client = createRfbClient({
    send: (bytes) => sent.push(bytes),
    onReady: (size) => events.push(`ready ${size.width}x${size.height}`),
    onUpdate: () => events.push('update'),
    onResize: (size) => events.push(`resize ${size.width}x${size.height}`),
    onError: (error) => errors.push(error),
  })
  return { client, sent, errors, events }
}
/** A session through ServerInit on a 4x3 screen, with the handshake sends cleared. */
function ready(width = 4, height = 3) {
  const s = session()
  for (const part of [VERSION, NONE_ONLY, SECURITY_OK, serverInit(width, height)])
    s.client.receive(part)
  s.sent.length = 0
  s.events.length = 0
  return s
}
const pixelAt = (rgba: Uint8Array, width: number, x: number, y: number) => [
  ...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
]

describe('RFB handshake', () => {
  it('speaks 3.8 with security None, shares the screen and asks for its pixel format', () => {
    const { client, sent, events } = session()
    client.receive(VERSION)
    expect(sent.at(-1)).toEqual(ascii('RFB 003.008\n'))
    client.receive(NONE_ONLY)
    expect(sent.at(-1)).toEqual(Uint8Array.of(1))
    client.receive(SECURITY_OK)
    expect(sent.at(-1)).toEqual(Uint8Array.of(1)) // ClientInit: shared
    expect(client.state).toBe('handshake')
    client.receive(serverInit(4, 3))
    const [format, encodings, request] = sent.slice(-3)
    // SetPixelFormat: 32 bpp, depth 24, little-endian true colour, R/G/B at shifts 0/8/16.
    expect([...(format as Uint8Array)]).toEqual([
      0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0,
    ])
    // SetEncodings: CopyRect, Raw, DesktopSize.
    expect([...(encodings as Uint8Array)]).toEqual([
      2,
      0,
      0,
      3,
      ...u32(1),
      ...u32(0),
      ...u32(-223 >>> 0),
    ])
    // A full (non-incremental) update of the whole screen.
    expect([...(request as Uint8Array)]).toEqual([3, 0, 0, 0, 0, 0, 0, 4, 0, 3])
    expect(events).toEqual(['ready 4x3'])
    expect(client.size).toEqual({ width: 4, height: 3 })
  })

  it('never surfaces the desktop name, which carries the host and user name', () => {
    const { client, events, errors } = ready()
    const seen = JSON.stringify({
      events,
      errors,
      size: client.size,
      state: client.state,
    })
    expect(seen).not.toContain('studio-host')
    expect(seen).not.toContain('owner')
  })

  it('skips the security result on 3.7, as the protocol says for None', () => {
    const { client, sent, events } = session()
    client.receive(ascii('RFB 003.007\n'))
    expect(sent.at(-1)).toEqual(ascii('RFB 003.007\n'))
    client.receive(NONE_ONLY)
    // Security type, then ClientInit at once.
    expect(sent.slice(-2)).toEqual([Uint8Array.of(1), Uint8Array.of(1)])
    client.receive(serverInit(2, 2))
    expect(events).toEqual(['ready 2x2'])
  })

  it.each(['RFB 003.003\n', 'RFB 004.000\n', 'HTTP/1.1 400\n'])(
    'refuses protocol version %j',
    (version) => {
      const { client, errors, sent } = session()
      client.receive(ascii(version))
      expect(errors[0]?.code).toBe('unsupported')
      expect(sent).toEqual([])
      expect(client.state).toBe('failed')
    },
  )

  it('refuses a server that offers no security type Cindl supports', () => {
    const { client, errors } = session()
    client.receive(VERSION)
    client.receive(Uint8Array.of(2, 2, 16)) // VNC authentication, Tight
    expect(errors[0]?.code).toBe('unsupported')
    expect(client.state).toBe('failed')
  })

  it('reports a refusal without repeating the server’s reason', () => {
    const reason = 'Too many connections from studio-host.invalid'
    for (const refusal of [
      Uint8Array.of(0, ...u32(reason.length), ...ascii(reason)),
      Uint8Array.of(...u32(1), ...u32(reason.length), ...ascii(reason)),
    ]) {
      const { client, errors } = session()
      client.receive(VERSION)
      if (refusal[0] !== 0) client.receive(NONE_ONLY)
      client.receive(refusal)
      expect(errors[0]?.code).toBe('unavailable')
      expect(JSON.stringify(errors[0]?.toJSON())).not.toContain('studio-host')
    }
  })
})

describe('RFB framebuffer', () => {
  it('decodes Raw rectangles into opaque RGBA', () => {
    const { client, events } = ready()
    client.receive(
      update(
        raw(1, 1, 2, 1, [
          [10, 20, 30],
          [40, 50, 60],
        ]),
      ),
    )
    expect(events).toEqual(['update'])
    const [region] = client.takeUpdate()
    expect(region).toMatchObject({ x: 0, y: 0, width: 4, height: 3 })
    const rgba = (region as { rgba: Uint8Array }).rgba
    expect(pixelAt(rgba, 4, 1, 1)).toEqual([10, 20, 30, 255])
    expect(pixelAt(rgba, 4, 2, 1)).toEqual([40, 50, 60, 255])
    expect(pixelAt(rgba, 4, 0, 0)).toEqual([0, 0, 0, 255])
    expect(client.takeUpdate()).toEqual([])
  })

  it('parses the same stream identically when it arrives one byte at a time', () => {
    const stream = Uint8Array.of(
      ...VERSION,
      ...NONE_ONLY,
      ...SECURITY_OK,
      ...serverInit(3, 2),
      ...update(
        raw(0, 0, 3, 2, [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
          [10, 11, 12],
          [13, 14, 15],
          [16, 17, 18],
        ]),
      ),
    )
    const whole = session()
    whole.client.receive(stream)
    const bytewise = session()
    for (const byte of stream) bytewise.client.receive(Uint8Array.of(byte))
    expect(bytewise.client.takeUpdate()).toEqual(whole.client.takeUpdate())
    expect(bytewise.sent).toEqual(whole.sent)
    expect(bytewise.events).toEqual(whole.events)
  })

  it('copies overlapping rectangles without smearing', () => {
    const { client } = ready(4, 1)
    client.receive(
      update(
        raw(0, 0, 4, 1, [
          [1, 1, 1],
          [2, 2, 2],
          [3, 3, 3],
          [4, 4, 4],
        ]),
      ),
    )
    client.takeUpdate()
    // Shift the first three pixels right by one: the source and destination overlap.
    client.receive(update(copy(1, 0, 3, 1, 0, 0)))
    const [region] = client.takeUpdate()
    expect(region).toMatchObject({ x: 1, y: 0, width: 3, height: 1 })
    expect([...(region as { rgba: Uint8Array }).rgba]).toEqual([
      1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255,
    ])
  })

  it('keeps separate changes apart and merges them past sixteen', () => {
    const { client } = ready(64, 64)
    client.takeUpdate()
    client.receive(update(raw(0, 0, 1, 1, [[9, 9, 9]]), raw(40, 40, 1, 1, [[8, 8, 8]])))
    expect(client.takeUpdate().map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [40, 40],
    ])
    const many = Array.from({ length: 20 }, (_, i) =>
      raw(i * 3, i * 3, 1, 1, [[i, i, i]]),
    )
    client.receive(update(...many))
    const regions = client.takeUpdate()
    // Bounded: past sixteen, the list folds into a bounding box.
    expect(regions.length).toBeLessThanOrEqual(16)
    expect(regions.length).toBeLessThan(20)
    // Every change is still covered, with its current pixels.
    for (let i = 0; i < 20; i++) {
      const at = i * 3
      const region = regions.find(
        (r) => at >= r.x && at < r.x + r.width && at >= r.y && at < r.y + r.height,
      )
      expect(region).toBeDefined()
      const { x, y, width, rgba } = region as {
        x: number
        y: number
        width: number
        rgba: Uint8Array
      }
      expect(pixelAt(rgba, width, at - x, at - y)).toEqual([i, i, i, 255])
    }
  })

  it('follows a new screen size and asks for a full picture', () => {
    const { client, events, sent } = ready()
    client.receive(update(desktopSize(8, 2)))
    expect(events).toEqual(['resize 8x2', 'update'])
    expect([...(sent.at(-1) as Uint8Array)]).toEqual([3, 0, 0, 0, 0, 0, 0, 8, 0, 2])
    expect(client.takeUpdate()[0]).toMatchObject({ width: 8, height: 2 })
  })

  it('asks for incremental updates when the viewer has painted', () => {
    const { client, sent } = ready()
    client.requestUpdate()
    expect([...(sent.at(-1) as Uint8Array)]).toEqual([3, 1, 0, 0, 0, 0, 0, 4, 0, 3])
  })

  it('drops clipboard text and colour maps and ignores the bell', () => {
    const { client, events } = ready()
    const clip = 'pasted secret'
    client.receive(Uint8Array.of(3, 0, 0, 0, ...u32(clip.length), ...ascii(clip)))
    client.receive(
      Uint8Array.of(1, 0, ...u16(0), ...u16(2), ...new Array<number>(12).fill(7)),
    )
    client.receive(Uint8Array.of(2))
    client.receive(update(raw(0, 0, 1, 1, [[5, 6, 7]])))
    expect(client.state).toBe('ready')
    expect(events).toEqual(['update'])
    const [region] = client.takeUpdate()
    expect(pixelAt((region as { rgba: Uint8Array }).rgba, 4, 0, 0)).toEqual([
      5, 6, 7, 255,
    ])
  })
})

describe('RFB from an untrusted server', () => {
  it.each([
    [
      'a rectangle outside the screen',
      update(
        raw(3, 2, 2, 1, [
          [1, 1, 1],
          [1, 1, 1],
        ]),
      ),
    ],
    ['a copy from outside the screen', update(copy(0, 0, 2, 2, 3, 2))],
    [
      'an encoding Cindl did not ask for',
      Uint8Array.of(
        0,
        0,
        ...u16(1),
        ...u16(0),
        ...u16(0),
        ...u16(1),
        ...u16(1),
        ...u32(16),
      ),
    ],
    ['an unknown message type', Uint8Array.of(99)],
    ['a zero-sized screen', update(desktopSize(0, 4))],
    ['an oversized screen', update(desktopSize(RFB_MAX_SIDE + 1, 4))],
  ])('stops at %s', (_label, bytes) => {
    const { client, errors, sent } = ready()
    client.receive(bytes)
    expect(errors[0]?.code).toBe('protocol')
    expect(client.state).toBe('failed')
    // Nothing is parsed or sent after a failure.
    client.receive(update(raw(0, 0, 1, 1, [[1, 1, 1]])))
    client.requestUpdate()
    expect(sent).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('refuses an oversized framebuffer before allocating it', () => {
    const { client, errors } = session()
    for (const part of [VERSION, NONE_ONLY, SECURITY_OK]) client.receive(part)
    client.receive(serverInit(RFB_MAX_SIDE + 1, 10))
    expect(errors[0]?.code).toBe('protocol')
    expect(client.size).toBeUndefined()
  })
})

describe('RFB input', () => {
  it('sends nothing until this viewer holds control', () => {
    const { client, sent } = ready()
    expect(client.pointer(1, 1, 1)).toBe(false)
    expect(client.key(0x61, true)).toBe(false)
    expect(sent).toEqual([])
  })

  it('encodes pointer and key events, clamped to the screen, while in control', () => {
    const { client, sent } = ready()
    client.setControlling(true)
    expect(client.pointer(2, 1, 1)).toBe(true)
    expect([...(sent.at(-1) as Uint8Array)]).toEqual([5, 1, 0, 2, 0, 1])
    client.pointer(500, -3, 0)
    expect([...(sent.at(-1) as Uint8Array)]).toEqual([5, 0, 0, 3, 0, 0])
    expect(client.key(0xff0d, true)).toBe(true)
    expect([...(sent.at(-1) as Uint8Array)]).toEqual([4, 1, 0, 0, ...u32(0xff0d)])
  })

  it('releases held keys and buttons when control is given up', () => {
    const { client, sent } = ready()
    client.setControlling(true)
    client.key(0xffe1, true)
    client.pointer(1, 1, 4)
    sent.length = 0
    client.setControlling(false)
    expect(sent.map((bytes) => [...bytes])).toEqual([
      [4, 0, 0, 0, ...u32(0xffe1)],
      [5, 0, 0, 0, 0, 0],
    ])
    expect(client.key(0x61, true)).toBe(false)
  })
})

describe('keysymForKey', () => {
  it.each<[string, number | undefined]>([
    ['a', 0x61],
    ['A', 0x41],
    [' ', 0x20],
    ['é', 0xe9],
    ['€', 0x010020ac],
    ['😀', 0x0101f600],
    ['Enter', 0xff0d],
    ['ArrowLeft', 0xff51],
    ['F12', 0xffc9],
    ['Dead', undefined],
    ['Process', undefined],
    ['ab', undefined],
    ['\u0007', undefined],
    ['__proto__', undefined],
    ['toString', undefined],
  ])('maps %j to %s', (key, keysym) => {
    expect(keysymForKey(key)).toBe(keysym)
  })
})

it('reports failures as CindlError', () => {
  const { client, errors } = session()
  client.receive(ascii('RFB 009.000\n'))
  expect(errors[0]).toBeInstanceOf(CindlError)
})
