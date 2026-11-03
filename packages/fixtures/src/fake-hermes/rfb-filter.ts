/**
 * TEST-ONLY port of Hermes's byte-level RFB client gate
 * (tools/bot_desktop/rfb_filter.py at v0.22.5). It parses the client stream,
 * which does not align with WebSocket frames, and passes input only while
 * `allowInput()` says this viewer holds the lease: KeyEvent, PointerEvent,
 * ClientCutText, SetDesktopSize (it resizes the agent's screen) and the QEMU
 * Extended KeyEvent noVNC switches to. Everything else (pixel format,
 * encodings, update requests, EnableContinuousUpdates, Fence) always passes,
 * so a watcher keeps receiving the picture.
 */

/** KeyEvent, PointerEvent, ClientCutText, SetDesktopSize, QEMU Extended KeyEvent (:20). */
const INPUT_TYPES = new Set([4, 5, 6, 251, 255])
/** Fixed-length client messages: type -> total length including the type byte (:23-30). */
const FIXED: Record<number, number> = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 255: 12 }
const SET_ENCODINGS = 2
const CLIENT_CUT_TEXT = 6
const FENCE = 248
/** u8 type, pad, u16 width, u16 height, u8 nScreens, pad, then 16 bytes per screen (:34). */
const SET_DESKTOP_SIZE = 251
/** TigerVNC's MaxCutText, which Xvnc and the bridge share (:36-39). */
const MAX_CUT_TEXT = 256 * 1024
/** Security None: 12-byte version, 1-byte security choice, 1-byte ClientInit (:52). */
const HANDSHAKE_BYTES = 14

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export class RfbClientFilter {
  readonly #allowInput: () => boolean
  #buffer: Uint8Array = new Uint8Array(0)
  #handshake = HANDSHAKE_BYTES
  /** Input messages passed and dropped, for assertions. Never their content. */
  passedInput = 0
  droppedInput = 0

  constructor(allowInput: () => boolean) {
    this.#allowInput = allowInput
  }

  /** Feed client bytes; get back the bytes allowed to reach the screen. Throws on a malformed stream. */
  feed(chunk: Uint8Array): Uint8Array {
    this.#buffer = join([this.#buffer, chunk])
    const out: Uint8Array[] = []
    if (this.#handshake > 0) {
      const count = Math.min(this.#handshake, this.#buffer.length)
      const head = this.#buffer.slice(0, count)
      this.#buffer = this.#buffer.slice(count)
      this.#handshake -= count
      // ClientInit's shared flag is forced on, so a viewer never disconnects
      // the agent's other watchers (:61-64).
      if (this.#handshake === 0 && count >= 1) head[count - 1] = 1
      out.push(head)
      if (this.#handshake > 0) return join(out)
    }
    while (this.#buffer.length > 0) {
      const length = this.#messageLength()
      if (length === undefined || this.#buffer.length < length) break
      const message = this.#buffer.slice(0, length)
      this.#buffer = this.#buffer.slice(length)
      const type = message[0] ?? -1
      if (INPUT_TYPES.has(type)) {
        if (!this.#allowInput()) {
          this.droppedInput++
          continue
        }
        this.passedInput++
      }
      out.push(message)
    }
    return join(out)
  }

  #messageLength(): number | undefined {
    const buffer = this.#buffer
    const type = buffer[0] ?? -1
    const fixed = FIXED[type]
    if (fixed !== undefined) return fixed
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    if (type === SET_ENCODINGS)
      return buffer.length < 4 ? undefined : 4 + 4 * view.getUint16(2)
    if (type === CLIENT_CUT_TEXT) {
      if (buffer.length < 8) return undefined
      // A negative length is the extended clipboard: |n| bytes follow (:93-97).
      const size = Math.abs(view.getInt32(4))
      if (size > MAX_CUT_TEXT) throw new Error('clipboard message too large')
      return 8 + size
    }
    if (type === FENCE) return buffer.length < 9 ? undefined : 9 + (buffer[8] ?? 0)
    if (type === SET_DESKTOP_SIZE)
      return buffer.length < 8 ? undefined : 8 + 16 * (buffer[6] ?? 0)
    // An unknown message cannot be framed, and forwarding it blind would let
    // input hide behind it (:106-108).
    throw new Error(`unknown RFB client message type ${type}`)
  }
}
