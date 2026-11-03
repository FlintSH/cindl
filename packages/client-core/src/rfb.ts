/**
 * A viewer for the agent-owned screen: the client half of RFB (RFC 6143) as
 * Hermes v0.22.5 serves it on `/api/display/ws` (raw RFB over a WebSocket,
 * security type None, a shared session; ADR 0012).
 *
 * The platform owns the socket: it passes every binary message to
 * `receive` and sends what `send` is given. The ticket that opened the socket
 * never reaches this module, and nothing here touches globals, so the desktop
 * main process, the web page and Android run the same code.
 *
 * The server is not trusted: every size and coordinate is checked before it
 * touches the framebuffer, and anything outside the subset Cindl asked for is
 * a protocol error. The desktop's name (Xvnc's default includes the host and
 * user name) and clipboard text are read and dropped, never surfaced.
 */
import { CindlError } from '@cindl/contracts'

/** Largest framebuffer side Cindl accepts (an 8K screen is 7680 wide). */
export const RFB_MAX_SIDE = 8192
/** Pixels Cindl requests: 32 bits, little-endian, red in the low byte. */
const BYTES_PER_PIXEL = 4
/** Dirty rectangles kept apart before they merge into their bounding box. */
const MAX_DIRTY_RECTS = 16
const MAX_NAME_LENGTH = 4096

const ENCODING_RAW = 0
const ENCODING_COPY_RECT = 1
const ENCODING_DESKTOP_SIZE = -223

export interface RfbRect {
  x: number
  y: number
  width: number
  height: number
}

/** Current pixels of one changed region, RGBA, rows top to bottom. */
export interface RfbRegion extends RfbRect {
  rgba: Uint8Array
}

export interface RfbClientOptions {
  /** Writes bytes to the socket. */
  send(bytes: Uint8Array): void
  /** The handshake finished and the first full update was requested. */
  onReady?(size: { width: number; height: number }): void
  /** A framebuffer update completed; call `takeUpdate` when ready to paint. */
  onUpdate?(): void
  /** The screen changed size; the whole framebuffer is dirty. */
  onResize?(size: { width: number; height: number }): void
  /** The session failed. The platform closes the socket; nothing more is sent. */
  onError?(error: CindlError): void
}

export interface RfbClient {
  /** Feeds bytes from the socket, in order. */
  receive(chunk: Uint8Array): void
  /** Changed regions since the last call, with their current pixels. */
  takeUpdate(): RfbRegion[]
  /** Asks the server for what changed (call after painting). */
  requestUpdate(): void
  /**
   * Whether this viewer holds the input lease. Hermes drops input from any
   * other viewer; Cindl does not send it at all. Giving control up releases
   * every key and button still held.
   */
  setControlling(controlling: boolean): void
  /** Pointer position and buttons (bit 0 left, 1 middle, 2 right, 3-4 wheel). False when not sent. */
  pointer(x: number, y: number, buttons: number): boolean
  /** An X11 keysym going down or up. False when not sent. */
  key(keysym: number, down: boolean): boolean
  /** Stops processing; later bytes are ignored. */
  close(): void
  readonly size: { width: number; height: number } | undefined
  readonly state: 'handshake' | 'ready' | 'closed' | 'failed'
}

/** Bytes received but not parsed yet, kept as chunks so large rects never copy twice. */
class ByteQueue {
  #chunks: Uint8Array[] = []
  #offset = 0
  #length = 0
  get length() {
    return this.#length
  }
  push(chunk: Uint8Array) {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#length += chunk.length
  }
  /** Copies `count` bytes into `target` at `at` and consumes them. */
  readInto(target: Uint8Array, at: number, count: number) {
    let written = 0
    while (written < count) {
      const chunk = this.#chunks[0] as Uint8Array
      const take = Math.min(count - written, chunk.length - this.#offset)
      target.set(chunk.subarray(this.#offset, this.#offset + take), at + written)
      written += take
      this.#offset += take
      if (this.#offset === chunk.length) {
        this.#chunks.shift()
        this.#offset = 0
      }
    }
    this.#length -= count
  }
  read(count: number): Uint8Array {
    const out = new Uint8Array(count)
    this.readInto(out, 0, count)
    return out
  }
  skip(count: number) {
    let left = count
    while (left > 0) {
      const chunk = this.#chunks[0] as Uint8Array
      const take = Math.min(left, chunk.length - this.#offset)
      left -= take
      this.#offset += take
      if (this.#offset === chunk.length) {
        this.#chunks.shift()
        this.#offset = 0
      }
    }
    this.#length -= count
  }
}

const u16 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] as number) << 8) | (bytes[at + 1] as number)
const u32 = (bytes: Uint8Array, at: number) =>
  (((bytes[at] as number) << 24) |
    ((bytes[at + 1] as number) << 16) |
    ((bytes[at + 2] as number) << 8) |
    (bytes[at + 3] as number)) >>>
  0
const s32 = (bytes: Uint8Array, at: number) => u32(bytes, at) | 0

function putU16(out: Uint8Array, at: number, value: number) {
  out[at] = (value >> 8) & 0xff
  out[at + 1] = value & 0xff
}
function putU32(out: Uint8Array, at: number, value: number) {
  out[at] = (value >>> 24) & 0xff
  out[at + 1] = (value >>> 16) & 0xff
  out[at + 2] = (value >>> 8) & 0xff
  out[at + 3] = value & 0xff
}

const protocolError = (detail: string) =>
  new CindlError('protocol', 'The agent’s screen sent data Cindl cannot read.', detail)

const validSide = (side: number) => side >= 1 && side <= RFB_MAX_SIDE

/** Merges `next` into the list, keeping at most MAX_DIRTY_RECTS. */
function addDirty(list: RfbRect[], next: RfbRect): RfbRect[] {
  const overlaps = (a: RfbRect, b: RfbRect) =>
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  let merged = next
  const kept: RfbRect[] = []
  for (const rect of list) {
    if (overlaps(rect, merged)) merged = bounds(rect, merged)
    else kept.push(rect)
  }
  kept.push(merged)
  return kept.length > MAX_DIRTY_RECTS ? [kept.reduce(bounds)] : kept
}
function bounds(a: RfbRect, b: RfbRect): RfbRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

type Step =
  | { kind: 'version' }
  | { kind: 'security-count' }
  | { kind: 'security-types'; count: number }
  | { kind: 'failure-reason' }
  | { kind: 'security-result' }
  | { kind: 'server-init' }
  | { kind: 'server-name'; length: number }
  | { kind: 'message' }
  | { kind: 'update-header' }
  | { kind: 'rect-header'; left: number }
  | { kind: 'raw'; rect: RfbRect; done: number; left: number }
  | { kind: 'copy-rect'; rect: RfbRect; left: number }
  | { kind: 'colour-map-header' }
  | { kind: 'skip'; bytes: number }
  | { kind: 'cut-text-header' }

export function createRfbClient(options: RfbClientOptions): RfbClient {
  const queue = new ByteQueue()
  let step: Step = { kind: 'version' }
  let minor = 8
  let state: RfbClient['state'] = 'handshake'
  let width = 0
  let height = 0
  let framebuffer = new Uint8Array(0)
  let dirty: RfbRect[] = []
  let controlling = false
  let buttonsDown = 0
  const keysDown = new Set<number>()

  const fail = (error: CindlError) => {
    if (state === 'closed' || state === 'failed') return
    state = 'failed'
    options.onError?.(error)
  }
  const send = (bytes: Uint8Array) => {
    if (state === 'handshake' || state === 'ready') options.send(bytes)
  }

  const allocate = (w: number, h: number) => {
    width = w
    height = h
    framebuffer = new Uint8Array(w * h * BYTES_PER_PIXEL)
    // Opaque black until the server paints.
    for (let i = 3; i < framebuffer.length; i += BYTES_PER_PIXEL) framebuffer[i] = 255
    dirty = [{ x: 0, y: 0, width: w, height: h }]
  }

  const updateRequest = (incremental: boolean) => {
    const out = new Uint8Array(10)
    out[0] = 3
    out[1] = incremental ? 1 : 0
    putU16(out, 6, width)
    putU16(out, 8, height)
    return out
  }

  const startSession = () => {
    // SetPixelFormat: 32 bpp, depth 24, little-endian true colour, red in the low byte.
    const format = new Uint8Array(20)
    format[0] = 0
    format[4] = 32
    format[5] = 24
    format[6] = 0
    format[7] = 1
    putU16(format, 8, 255)
    putU16(format, 10, 255)
    putU16(format, 12, 255)
    format[14] = 0
    format[15] = 8
    format[16] = 16
    send(format)
    const encodings = [ENCODING_COPY_RECT, ENCODING_RAW, ENCODING_DESKTOP_SIZE]
    const set = new Uint8Array(4 + 4 * encodings.length)
    set[0] = 2
    putU16(set, 2, encodings.length)
    encodings.forEach((encoding, i) => putU32(set, 4 + 4 * i, encoding >>> 0))
    send(set)
    send(updateRequest(false))
    state = 'ready'
    options.onReady?.({ width, height })
  }

  const insideFramebuffer = (rect: RfbRect) =>
    rect.x + rect.width <= width && rect.y + rect.height <= height

  /** Writes whole pixels of a Raw rect as they arrive. */
  const drainRaw = (current: Extract<Step, { kind: 'raw' }>) => {
    const { rect } = current
    const total = rect.width * rect.height
    while (current.done < total && queue.length >= BYTES_PER_PIXEL) {
      // Copy a run of whole pixels within one row straight into the framebuffer.
      const column = current.done % rect.width
      const row = Math.floor(current.done / rect.width)
      const run = Math.min(
        rect.width - column,
        Math.floor(queue.length / BYTES_PER_PIXEL),
      )
      const at = ((rect.y + row) * width + rect.x + column) * BYTES_PER_PIXEL
      queue.readInto(framebuffer, at, run * BYTES_PER_PIXEL)
      for (let i = 0; i < run; i++) framebuffer[at + i * BYTES_PER_PIXEL + 3] = 255
      current.done += run
    }
    return current.done === total
  }

  const copyRect = (rect: RfbRect, sourceX: number, sourceY: number) => {
    const rowBytes = rect.width * BYTES_PER_PIXEL
    const rows: Uint8Array[] = []
    // Read every source row first: source and destination may overlap.
    for (let row = 0; row < rect.height; row++) {
      const at = ((sourceY + row) * width + sourceX) * BYTES_PER_PIXEL
      rows.push(framebuffer.slice(at, at + rowBytes))
    }
    rows.forEach((pixels, row) =>
      framebuffer.set(pixels, ((rect.y + row) * width + rect.x) * BYTES_PER_PIXEL),
    )
  }

  /** Advances the parser; false when it needs more bytes. */
  const advance = (): boolean => {
    switch (step.kind) {
      case 'version': {
        if (queue.length < 12) return false
        const text = String.fromCharCode(...queue.read(12))
        const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(text)
        const major = match ? Number(match[1]) : NaN
        const serverMinor = match ? Number(match[2]) : NaN
        if (major !== 3 || serverMinor < 7) {
          fail(
            new CindlError(
              'unsupported',
              'The agent’s screen speaks a protocol version Cindl does not support.',
              `rfb version ${JSON.stringify(text.trim()).slice(0, 40)}`,
            ),
          )
          return false
        }
        minor = Math.min(serverMinor, 8)
        options.send(Uint8Array.from(`RFB 003.00${minor}\n`, (c) => c.charCodeAt(0)))
        step = { kind: 'security-count' }
        return true
      }
      case 'security-count': {
        if (queue.length < 1) return false
        const count = queue.read(1)[0] as number
        step =
          count === 0 ? { kind: 'failure-reason' } : { kind: 'security-types', count }
        return true
      }
      case 'security-types': {
        if (queue.length < step.count) return false
        const types = queue.read(step.count)
        if (!types.includes(1)) {
          fail(
            new CindlError(
              'unsupported',
              'The agent’s screen asked for a sign-in method Cindl does not support.',
              `rfb security types ${[...types].join(',')}`,
            ),
          )
          return false
        }
        options.send(Uint8Array.of(1))
        step = minor >= 8 ? { kind: 'security-result' } : { kind: 'server-init' }
        if (step.kind === 'server-init') options.send(Uint8Array.of(1))
        return true
      }
      case 'failure-reason': {
        if (queue.length < 4) return false
        // The reason is server text: report that it refused, not what it said.
        fail(new CindlError('unavailable', 'The agent’s screen refused the connection.'))
        return false
      }
      case 'security-result': {
        if (queue.length < 4) return false
        const status = u32(queue.read(4), 0)
        if (status !== 0) {
          step = { kind: 'failure-reason' }
          return true
        }
        // ClientInit: share the screen with the agent's own watcher and other viewers.
        options.send(Uint8Array.of(1))
        step = { kind: 'server-init' }
        return true
      }
      case 'server-init': {
        if (queue.length < 24) return false
        const head = queue.read(24)
        const w = u16(head, 0)
        const h = u16(head, 2)
        const nameLength = u32(head, 20)
        if (!validSide(w) || !validSide(h)) {
          fail(protocolError(`rfb framebuffer ${w}x${h}`))
          return false
        }
        if (nameLength > MAX_NAME_LENGTH) {
          fail(protocolError(`rfb name length ${nameLength}`))
          return false
        }
        allocate(w, h)
        step = { kind: 'server-name', length: nameLength }
        return true
      }
      case 'server-name': {
        if (queue.length < step.length) return false
        // Dropped: Xvnc names the desktop after the host and user.
        queue.skip(step.length)
        step = { kind: 'message' }
        startSession()
        return true
      }
      case 'message': {
        if (queue.length < 1) return false
        const type = queue.read(1)[0] as number
        if (type === 0) step = { kind: 'update-header' }
        else if (type === 1) step = { kind: 'colour-map-header' }
        else if (type === 2)
          step = { kind: 'message' } // Bell: nothing to show.
        else if (type === 3) step = { kind: 'cut-text-header' }
        else {
          fail(protocolError(`rfb server message ${type}`))
          return false
        }
        return true
      }
      case 'update-header': {
        if (queue.length < 3) return false
        const head = queue.read(3)
        const count = u16(head, 1)
        step = count === 0 ? { kind: 'message' } : { kind: 'rect-header', left: count }
        if (count === 0) options.onUpdate?.()
        return true
      }
      case 'rect-header': {
        if (queue.length < 12) return false
        const head = queue.read(12)
        const rect = {
          x: u16(head, 0),
          y: u16(head, 2),
          width: u16(head, 4),
          height: u16(head, 6),
        }
        const encoding = s32(head, 8)
        const left = step.left - 1
        if (encoding === ENCODING_DESKTOP_SIZE) {
          if (!validSide(rect.width) || !validSide(rect.height)) {
            fail(protocolError(`rfb desktop size ${rect.width}x${rect.height}`))
            return false
          }
          allocate(rect.width, rect.height)
          options.onResize?.({ width, height })
          send(updateRequest(false))
          return finishRect(left)
        }
        if (!insideFramebuffer(rect)) {
          fail(protocolError(`rfb rect ${rect.x},${rect.y} ${rect.width}x${rect.height}`))
          return false
        }
        if (encoding === ENCODING_RAW) {
          step = { kind: 'raw', rect, done: 0, left }
          return true
        }
        if (encoding === ENCODING_COPY_RECT) {
          step = { kind: 'copy-rect', rect, left }
          return true
        }
        fail(protocolError(`rfb encoding ${encoding}`))
        return false
      }
      case 'raw': {
        if (!drainRaw(step)) return false
        if (step.rect.width > 0 && step.rect.height > 0)
          dirty = addDirty(dirty, step.rect)
        return finishRect(step.left)
      }
      case 'copy-rect': {
        if (queue.length < 4) return false
        const head = queue.read(4)
        const sourceX = u16(head, 0)
        const sourceY = u16(head, 2)
        const { rect } = step
        if (!insideFramebuffer({ ...rect, x: sourceX, y: sourceY })) {
          fail(protocolError(`rfb copy source ${sourceX},${sourceY}`))
          return false
        }
        if (rect.width > 0 && rect.height > 0) {
          copyRect(rect, sourceX, sourceY)
          dirty = addDirty(dirty, rect)
        }
        return finishRect(step.left)
      }
      case 'colour-map-header': {
        // Unused with true colour; skip the entries (6 bytes each).
        if (queue.length < 5) return false
        const head = queue.read(5)
        step = { kind: 'skip', bytes: u16(head, 3) * 6 }
        return true
      }
      case 'cut-text-header': {
        if (queue.length < 7) return false
        const head = queue.read(7)
        // Clipboard text from the agent's screen is never read into Cindl.
        step = { kind: 'skip', bytes: u32(head, 3) }
        return true
      }
      case 'skip': {
        const take = Math.min(step.bytes, queue.length)
        queue.skip(take)
        step = { kind: 'skip', bytes: step.bytes - take }
        if (step.bytes > 0) return false
        step = { kind: 'message' }
        return true
      }
    }
  }

  const finishRect = (left: number) => {
    if (left > 0) step = { kind: 'rect-header', left }
    else {
      step = { kind: 'message' }
      options.onUpdate?.()
    }
    return true
  }

  return {
    receive(chunk) {
      if (state === 'closed' || state === 'failed') return
      queue.push(chunk)
      while ((state === 'handshake' || state === 'ready') && advance()) {
        // Keep parsing while whole messages are available.
      }
    },
    takeUpdate() {
      if (state !== 'ready') return []
      const regions = dirty.map((rect) => {
        const rgba = new Uint8Array(rect.width * rect.height * BYTES_PER_PIXEL)
        const rowBytes = rect.width * BYTES_PER_PIXEL
        for (let row = 0; row < rect.height; row++) {
          const at = ((rect.y + row) * width + rect.x) * BYTES_PER_PIXEL
          rgba.set(framebuffer.subarray(at, at + rowBytes), row * rowBytes)
        }
        return { ...rect, rgba }
      })
      dirty = []
      return regions
    },
    requestUpdate() {
      if (state === 'ready') send(updateRequest(true))
    },
    setControlling(next) {
      if (controlling && !next && state === 'ready') {
        for (const keysym of keysDown) send(keyEvent(keysym, false))
        if (buttonsDown !== 0) send(pointerEvent(0, 0, 0))
      }
      if (!next) {
        keysDown.clear()
        buttonsDown = 0
      }
      controlling = next
    },
    pointer(x, y, buttons) {
      if (!controlling || state !== 'ready') return false
      const px = Math.min(Math.max(Math.round(x), 0), width - 1)
      const py = Math.min(Math.max(Math.round(y), 0), height - 1)
      buttonsDown = buttons & 0xff
      send(pointerEvent(px, py, buttonsDown))
      return true
    },
    key(keysym, down) {
      if (!controlling || state !== 'ready') return false
      if (!Number.isInteger(keysym) || keysym < 0 || keysym > 0xffffffff) return false
      if (down) keysDown.add(keysym)
      else keysDown.delete(keysym)
      send(keyEvent(keysym, down))
      return true
    },
    close() {
      if (state !== 'failed') state = 'closed'
    },
    get size() {
      return state === 'ready' ? { width, height } : undefined
    },
    get state() {
      return state
    },
  }
}

function pointerEvent(x: number, y: number, buttons: number) {
  const out = new Uint8Array(6)
  out[0] = 5
  out[1] = buttons
  putU16(out, 2, x)
  putU16(out, 4, y)
  return out
}
function keyEvent(keysym: number, down: boolean) {
  const out = new Uint8Array(8)
  out[0] = 4
  out[1] = down ? 1 : 0
  putU32(out, 4, keysym)
  return out
}

/** X11 keysyms for the non-printing keys of DOM `KeyboardEvent.key`. */
const NAMED_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Shift: 0xffe1,
  Control: 0xffe3,
  CapsLock: 0xffe5,
  Meta: 0xffe7,
  Alt: 0xffe9,
  Super: 0xffeb,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
}

/**
 * The X11 keysym for a DOM `KeyboardEvent.key` value, or undefined for keys
 * Cindl does not forward (dead keys, IME composition, unknown names).
 */
export function keysymForKey(key: string): number | undefined {
  if (Object.hasOwn(NAMED_KEYSYMS, key)) return NAMED_KEYSYMS[key]
  const points = [...key]
  if (points.length !== 1) return undefined
  const code = (points[0] as string).codePointAt(0) as number
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return undefined
  // Latin-1 keysyms equal their code point; the rest are Unicode keysyms.
  return code <= 0xff ? code : 0x01000000 + code
}
