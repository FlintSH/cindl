/**
 * SYNTHETIC screen for the labelled demo and tests: a stand-in for Xvnc behind
 * Hermes's `/api/display/ws`, speaking real RFB 3.8 bytes (security None,
 * Raw rectangles) so the demo runs Cindl's actual RFB client. It draws a
 * fictional desktop that says "SYNTHETIC DEMO SCREEN" across its top bar. A
 * progress bar advances on every incremental update request, a pointer marker
 * follows pointer input, and printable keys type blocks into a notes line.
 */

/** Pixels as the RFB client asks for them: R, G, B, unused. */
type Colour = readonly [number, number, number]

const palette = {
  desktop: [47, 93, 98],
  bar: [31, 42, 48],
  barText: [236, 228, 214],
  window: [244, 239, 230],
  title: [201, 183, 156],
  grid: [219, 210, 196],
  ink: [52, 48, 43],
  progressTrack: [226, 216, 200],
  progress: [176, 98, 54],
  pointer: [230, 120, 40],
} satisfies Record<string, Colour>

/** 5x7 glyphs for the label, one row per number, high bit on the left. */
const GLYPHS: Record<string, number[]> = {
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  ' ': [0, 0, 0, 0, 0, 0, 0],
}
export const SYNTHETIC_SCREEN_LABEL = 'SYNTHETIC DEMO SCREEN'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]

export interface SyntheticScreen {
  readonly width: number
  readonly height: number
  /** One RFB session. `toClient` receives server bytes, synchronously. */
  connect(toClient: (bytes: Uint8Array) => void): { receive(bytes: Uint8Array): void }
}

export function createSyntheticScreen(
  size = { width: 640, height: 400 },
): SyntheticScreen {
  const { width, height } = size
  const base = new Uint8Array(width * height * 4)
  const fill = (target: Uint8Array, rect: Rect, colour: Colour) => {
    for (let y = rect.y; y < Math.min(rect.y + rect.height, height); y++)
      for (let x = rect.x; x < Math.min(rect.x + rect.width, width); x++) {
        const at = (y * width + x) * 4
        target[at] = colour[0]
        target[at + 1] = colour[1]
        target[at + 2] = colour[2]
      }
  }
  const text = (
    target: Uint8Array,
    at: { x: number; y: number },
    label: string,
    scale: number,
  ) => {
    let cursor = at.x
    for (const letter of label) {
      const rows = GLYPHS[letter] ?? GLYPHS[' ']
      rows?.forEach((bits, row) => {
        for (let column = 0; column < 5; column++)
          if (bits & (1 << (4 - column)))
            fill(
              target,
              {
                x: cursor + column * scale,
                y: at.y + row * scale,
                width: scale,
                height: scale,
              },
              palette.barText,
            )
      })
      cursor += 6 * scale
    }
  }

  // The fictional desktop: a labelled top bar and one window with a sheet.
  const window: Rect = { x: 48, y: 56, width: width - 96, height: height - 104 }
  const progressTrack: Rect = {
    x: window.x + 16,
    y: window.y + window.height - 28,
    width: window.width - 32,
    height: 10,
  }
  const notes: Rect = {
    x: window.x + 16,
    y: window.y + window.height - 56,
    width: window.width - 32,
    height: 16,
  }
  fill(base, { x: 0, y: 0, width, height }, palette.desktop)
  fill(base, { x: 0, y: 0, width, height: 28 }, palette.bar)
  text(base, { x: 12, y: 7 }, SYNTHETIC_SCREEN_LABEL, 2)
  fill(base, window, palette.window)
  fill(base, { ...window, height: 22 }, palette.title)
  for (let row = 0; row < 6; row++)
    fill(
      base,
      {
        x: window.x + 16,
        y: window.y + 40 + row * 24,
        width: window.width - 32,
        height: 1,
      },
      palette.grid,
    )
  for (let column = 1; column < 4; column++)
    fill(
      base,
      {
        x: window.x + 16 + column * Math.floor((window.width - 32) / 4),
        y: window.y + 40,
        width: 1,
        height: 120,
      },
      palette.grid,
    )
  fill(base, progressTrack, palette.progressTrack)
  fill(base, notes, palette.grid)

  const screen = base.slice()
  let progress = 0
  let typed = 0
  let marker: Rect | undefined
  const dirty: Rect[] = []

  const restore = (rect: Rect) => {
    for (let y = rect.y; y < Math.min(rect.y + rect.height, height); y++) {
      const at = (y * width + rect.x) * 4
      const end = (y * width + Math.min(rect.x + rect.width, width)) * 4
      screen.set(base.subarray(at, end), at)
    }
  }
  const advance = () => {
    progress = (progress + 6) % (progressTrack.width + 6)
    restore(progressTrack)
    fill(screen, { ...progressTrack, width: progress }, palette.progress)
    dirty.push(progressTrack)
  }
  const movePointer = (x: number, y: number) => {
    if (marker) {
      restore(marker)
      dirty.push(marker)
    }
    marker = {
      x: Math.max(0, Math.min(x - 4, width - 8)),
      y: Math.max(0, Math.min(y - 4, height - 8)),
      width: 8,
      height: 8,
    }
    fill(screen, marker, palette.pointer)
    dirty.push(marker)
  }
  const typeBlock = () => {
    const step = 10
    const perLine = Math.floor((notes.width - 8) / step)
    if (typed === perLine) {
      typed = 0
      restore(notes)
    }
    fill(
      screen,
      { x: notes.x + 4 + typed * step, y: notes.y + 4, width: 7, height: 8 },
      palette.ink,
    )
    typed += 1
    dirty.push(notes)
  }
  const rawRect = (rect: Rect) => {
    const out = new Uint8Array(12 + rect.width * rect.height * 4)
    out.set([
      ...u16(rect.x),
      ...u16(rect.y),
      ...u16(rect.width),
      ...u16(rect.height),
      ...u32(0),
    ])
    for (let row = 0; row < rect.height; row++) {
      const at = ((rect.y + row) * width + rect.x) * 4
      out.set(screen.subarray(at, at + rect.width * 4), 12 + row * rect.width * 4)
    }
    return out
  }
  const updateMessage = (rects: Rect[]) => {
    const encoded = rects.map(rawRect)
    const out = new Uint8Array(4 + encoded.reduce((sum, rect) => sum + rect.length, 0))
    out.set([0, 0, ...u16(rects.length)])
    let at = 4
    for (const rect of encoded) {
      out.set(rect, at)
      at += rect.length
    }
    return out
  }

  return {
    width,
    height,
    connect(toClient) {
      let phase: 'version' | 'security' | 'init' | 'messages' = 'version'
      let pending = new Uint8Array(0)
      toClient(ascii('RFB 003.008\n'))
      return {
        receive(bytes) {
          const joined = new Uint8Array(pending.length + bytes.length)
          joined.set(pending)
          joined.set(bytes, pending.length)
          pending = joined
          const take = (count: number) => {
            const head = pending.slice(0, count)
            pending = pending.slice(count)
            return head
          }
          for (;;) {
            if (phase === 'version') {
              if (pending.length < 12) return
              take(12)
              toClient(Uint8Array.of(1, 1)) // one security type: None
              phase = 'security'
            } else if (phase === 'security') {
              if (pending.length < 1) return
              take(1)
              toClient(Uint8Array.of(...u32(0)))
              phase = 'init'
            } else if (phase === 'init') {
              if (pending.length < 1) return
              take(1)
              const name = ascii('Synthetic demo screen')
              toClient(
                Uint8Array.of(
                  ...u16(width),
                  ...u16(height),
                  ...new Array<number>(16).fill(0),
                  ...u32(name.length),
                  ...name,
                ),
              )
              phase = 'messages'
            } else {
              if (pending.length < 1) return
              const messageType = pending[0] as number
              const length =
                messageType === 0
                  ? 20
                  : messageType === 2
                    ? pending.length >= 4
                      ? 4 + 4 * (((pending[2] as number) << 8) | (pending[3] as number))
                      : undefined
                    : messageType === 3
                      ? 10
                      : messageType === 4
                        ? 8
                        : messageType === 5
                          ? 6
                          : messageType === 6
                            ? pending.length >= 8
                              ? 8 +
                                (((pending[4] as number) << 24) |
                                  ((pending[5] as number) << 16) |
                                  ((pending[6] as number) << 8) |
                                  (pending[7] as number))
                              : undefined
                            : -1
              if (length === -1)
                throw new Error(`synthetic screen: unknown client message ${messageType}`)
              if (length === undefined || pending.length < length) return
              const message = take(length)
              if (messageType === 3) {
                const incremental = message[1] === 1
                if (!incremental) {
                  dirty.length = 0
                  toClient(updateMessage([{ x: 0, y: 0, width, height }]))
                } else {
                  advance()
                  const rects = dirty.splice(0)
                  toClient(updateMessage(rects))
                }
              } else if (messageType === 5) {
                movePointer(
                  ((message[2] as number) << 8) | (message[3] as number),
                  ((message[4] as number) << 8) | (message[5] as number),
                )
              } else if (messageType === 4 && message[1] === 1) {
                const keysym =
                  (((message[4] as number) << 24) |
                    ((message[5] as number) << 16) |
                    ((message[6] as number) << 8) |
                    (message[7] as number)) >>>
                  0
                if (keysym >= 0x20 && keysym < 0xff00) typeBlock()
              }
            }
          }
        },
      }
    },
  }
}
