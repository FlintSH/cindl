/**
 * What one full update of the agent's screen costs on the JavaScript side of
 * the Android app, for the painting choice in docs/handbook/clients/android.md:
 *
 *   node apps/android/scripts/measure-screen.ts [width] [height]
 *   node --no-opt --no-sparkplug --no-maglev apps/android/scripts/measure-screen.ts
 *     (V8's interpreter only: closer to Hermes, which has no JIT)
 *
 * It builds the Raw RFB update a screen of that size sends for a full repaint,
 * then times each step the app takes: React Native's base64 decode of the
 * binary frame (the same table-driven algorithm as base64-js, which React
 * Native's WebSocket uses), Cindl's RFB client reading it and copying the
 * changed region out, and, for comparison, the pure-JavaScript fallback that
 * would encode the picture as a BMP data URI for <Image>. The Kotlin side
 * (OkHttp's base64 encode, the JSI hand-over, the ARGB conversion and
 * Bitmap.setPixels) runs only on a device and is not measured here.
 * SYNTHETIC pixels only.
 */
import { createRfbClient } from '@cindl/client-core'

const width = Number(process.argv[2] ?? 1280)
const height = Number(process.argv[3] ?? 800)
const RUNS = 5

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]

/** ServerInit and the rest of an RFB 3.8 handshake with security None. */
function handshake(): Uint8Array {
  const name = new TextEncoder().encode('SYNTHETIC')
  return Uint8Array.from([
    ...new TextEncoder().encode('RFB 003.008\n'),
    1,
    1,
    ...u32(0),
    ...u16(width),
    ...u16(height),
    // 32 bpp, depth 24, little-endian, true colour, 255/255/255, shifts 0/8/16, padding.
    32,
    24,
    0,
    1,
    ...u16(255),
    ...u16(255),
    ...u16(255),
    0,
    8,
    16,
    0,
    0,
    0,
    ...u32(name.length),
    ...name,
  ])
}

/** One FramebufferUpdate with a single Raw rectangle covering the screen. */
function fullRawUpdate(): Uint8Array {
  const header = Uint8Array.from([
    0,
    0,
    ...u16(1),
    ...u16(0),
    ...u16(0),
    ...u16(width),
    ...u16(height),
    ...u32(0),
  ])
  const out = new Uint8Array(header.length + width * height * 4)
  out.set(header)
  for (let i = header.length, p = 0; i < out.length; i += 4, p++) {
    out[i] = p & 0xff
    out[i + 1] = (p >> 8) & 0xff
    out[i + 2] = (p >> 16) & 0xff
    out[i + 3] = 0
  }
  return out
}

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const lookup = new Uint8Array(256)
for (let i = 0; i < CHARS.length; i++) lookup[CHARS.charCodeAt(i)] = i

/** base64-js `fromByteArray`, as Kotlin's ByteString.base64() produces it. */
function toBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk: string[] = []
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    const t = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    chunk.push(
      CHARS[(t >> 18) & 63]! +
        CHARS[(t >> 12) & 63]! +
        CHARS[(t >> 6) & 63]! +
        CHARS[t & 63]!,
    )
    if (chunk.length === 4096) {
      out += chunk.join('')
      chunk.length = 0
    }
  }
  out += chunk.join('')
  const rest = bytes.length % 3
  if (rest === 1) {
    const t = bytes[bytes.length - 1] ?? 0
    out += `${CHARS[t >> 2]!}${CHARS[(t << 4) & 63]!}==`
  } else if (rest === 2) {
    const t = ((bytes[bytes.length - 2] ?? 0) << 8) | (bytes[bytes.length - 1] ?? 0)
    out += `${CHARS[t >> 10]!}${CHARS[(t >> 4) & 63]!}${CHARS[(t << 2) & 63]!}=`
  }
  return out
}

/** base64-js `toByteArray`: what React Native's WebSocket runs on every binary message. */
function fromBase64(text: string): Uint8Array {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length * 3) / 4 - padding)
  let j = 0
  const whole = padding ? text.length - 4 : text.length
  for (let i = 0; i < whole; i += 4) {
    const t =
      ((lookup[text.charCodeAt(i)] ?? 0) << 18) |
      ((lookup[text.charCodeAt(i + 1)] ?? 0) << 12) |
      ((lookup[text.charCodeAt(i + 2)] ?? 0) << 6) |
      (lookup[text.charCodeAt(i + 3)] ?? 0)
    out[j++] = (t >> 16) & 0xff
    out[j++] = (t >> 8) & 0xff
    out[j++] = t & 0xff
  }
  if (padding === 2) {
    const t =
      ((lookup[text.charCodeAt(whole)] ?? 0) << 2) |
      ((lookup[text.charCodeAt(whole + 1)] ?? 0) >> 4)
    out[j] = t & 0xff
  } else if (padding === 1) {
    const t =
      ((lookup[text.charCodeAt(whole)] ?? 0) << 10) |
      ((lookup[text.charCodeAt(whole + 1)] ?? 0) << 4) |
      ((lookup[text.charCodeAt(whole + 2)] ?? 0) >> 2)
    out[j++] = (t >> 8) & 0xff
    out[j] = t & 0xff
  }
  return out
}

/** The fallback: the whole picture as a 24-bit BMP data URI for <Image>. */
function bmpDataUri(rgba: Uint8Array): string {
  const row = width * 3
  const pixels = row * height
  const file = new Uint8Array(54 + pixels)
  const view = new DataView(file.buffer)
  file[0] = 0x42
  file[1] = 0x4d
  view.setUint32(2, file.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, -height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, pixels, true)
  for (let p = 0, o = 54; p < width * height; p++, o += 3) {
    file[o] = rgba[p * 4 + 2] ?? 0
    file[o + 1] = rgba[p * 4 + 1] ?? 0
    file[o + 2] = rgba[p * 4] ?? 0
  }
  return `data:image/bmp;base64,${toBase64(file)}`
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
function time<T>(work: () => T): { ms: number; result: T } {
  const times: number[] = []
  let result: T | undefined
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now()
    result = work()
    times.push(performance.now() - started)
  }
  return { ms: median(times), result: result as T }
}

const update = fullRawUpdate()
const wire = toBase64(update)
const decode = time(() => fromBase64(wire))

let regions: Array<{ rgba: Uint8Array }> = []
const rfb = time(() => {
  const client = createRfbClient({ send: () => undefined })
  client.receive(handshake())
  client.receive(decode.result)
  regions = client.takeUpdate()
  return regions.length
})
const rgba = regions[0]?.rgba ?? new Uint8Array(width * height * 4)
const fallback = time(() => bmpDataUri(rgba))

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`
const mode = process.execArgv.length ? `node ${process.execArgv.join(' ')}` : 'node'
console.log(`Full ${width}x${height} Raw update (${mode}, median of ${RUNS})`)
console.log(
  `  RFB bytes on the socket:          ${update.length.toLocaleString('en-US')} (${mb(update.length)})`,
)
console.log(
  `  base64 across the bridge:         ${wire.length.toLocaleString('en-US')} characters (${mb(wire.length)})`,
)
console.log(`  JS base64 decode (base64-js):     ${decode.ms.toFixed(1)} ms`)
console.log(
  `  RFB client read + region copy:    ${rfb.ms.toFixed(1)} ms (${rfb.result} region, ${mb(rgba.length)})`,
)
console.log(
  `  To the Kotlin picture:            a typed array read in place through JSI (no copy in JS)`,
)
console.log(
  `  Fallback BMP data URI for <Image>: ${fallback.ms.toFixed(1)} ms, ${fallback.result.length.toLocaleString('en-US')} characters per frame`,
)
