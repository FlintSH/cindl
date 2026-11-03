/**
 * TEST-ONLY port of Hermes's byte-level RFB client gate
 * (tools/bot_desktop/rfb_filter.py:42-120 at v0.22.5). It parses the client
 * stream, which does not align with WebSocket frames, and passes keyboard,
 * pointer and clipboard messages only while `allowInput()` says this viewer
 * holds the lease. Everything else (pixel format, encodings, update requests)
 * always passes, so a watcher keeps receiving the picture.
 */

/** KeyEvent, PointerEvent, ClientCutText. */
const INPUT_TYPES = new Set([4, 5, 6])
/** Fixed-length client messages: type -> total length including the type byte. */
const FIXED: Record<number, number> = { 0: 20, 3: 10, 4: 8, 5: 6 }
const SET_ENCODINGS = 2
const CLIENT_CUT_TEXT = 6
/** Security None: 12-byte version, 1-byte security choice, 1-byte ClientInit. */
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
      out.push(this.#buffer.slice(0, count))
      this.#buffer = this.#buffer.slice(count)
      this.#handshake -= count
    }
    while (this.#handshake === 0 && this.#buffer.length > 0) {
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
    const type = this.#buffer[0] ?? -1
    const fixed = FIXED[type]
    if (fixed !== undefined) return fixed
    const view = new DataView(
      this.#buffer.buffer,
      this.#buffer.byteOffset,
      this.#buffer.byteLength,
    )
    if (type === SET_ENCODINGS)
      return this.#buffer.length < 4 ? undefined : 4 + 4 * view.getUint16(2)
    if (type === CLIENT_CUT_TEXT)
      return this.#buffer.length < 8 ? undefined : 8 + view.getUint32(4)
    throw new Error(`unknown RFB client message type ${type}`)
  }
}
