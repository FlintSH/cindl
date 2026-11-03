import type { BinaryWebSocketFactory, BinaryWebSocketLike } from '@cindl/client-core'
import { wsPaths } from '@cindl/hermes-adapter'
import { isAllowedHermesUrl } from './origin.ts'

const DISPLAY_TICKET = 'display_ticket'
/** Hermes tickets are URL-safe strings. */
const TICKET = /^[A-Za-z0-9._~-]{8,512}$/

/**
 * Checks a screen socket request before anything is sent (desktop parity:
 * apps/desktop/src/main/platform/websocket.ts). Hermes's screen socket takes
 * its single-use ticket only in the query (ADR 0012), so the URL is a secret:
 * it may go only to `/api/display/ws` on the signed-in origin (wss for https,
 * ws only on this device's loopback address), with the ticket as its one
 * query parameter.
 */
export function checkDisplaySocketRequest(
  rawUrl: string,
  hermesOrigin: string | undefined,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (!hermesOrigin) return { ok: false, reason: 'not-signed-in' }
  let url: URL
  let origin: URL
  try {
    url = new URL(rawUrl)
    origin = new URL(hermesOrigin)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  const expectedProtocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  if (url.protocol !== expectedProtocol || !isAllowedHermesUrl(url.href))
    return { ok: false, reason: 'scheme' }
  if (url.host !== origin.host) return { ok: false, reason: 'origin' }
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'credentials' }
  if (url.hash !== '') return { ok: false, reason: 'fragment' }
  if (url.pathname !== wsPaths.display) return { ok: false, reason: 'path' }
  const keys = [...url.searchParams.keys()]
  const ticket = url.searchParams.get(DISPLAY_TICKET)
  if (keys.length !== 1 || keys[0] !== DISPLAY_TICKET || !ticket || !TICKET.test(ticket))
    return { ok: false, reason: 'ticket' }
  return { ok: true, url: url.href }
}

/** The parts of React Native's WebSocket (and the WHATWG one) a binary socket uses. */
export interface RnWebSocketLike {
  binaryType: string
  readonly readyState: number
  send(data: ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type RnWebSocketConstructor = new (url: string) => RnWebSocketLike

/** Any message as a plain Uint8Array over the same memory; text frames as their UTF-8 bytes. */
function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return undefined
}

function adapt(socket: RnWebSocketLike): BinaryWebSocketLike {
  const like: BinaryWebSocketLike = {
    get readyState() {
      return socket.readyState
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  socket.onopen = () => like.onopen?.({ type: 'open' })
  socket.onmessage = (event) => {
    const bytes = toBytes(event.data)
    if (bytes) like.onmessage?.({ data: bytes })
  }
  socket.onclose = (event) =>
    like.onclose?.({ code: event.code, reason: event.reason ?? '' })
  // The error is not forwarded: its text can echo the URL, and the URL holds the ticket.
  socket.onerror = () => like.onerror?.({ type: 'error' })
  return like
}

/**
 * BinaryWebSocketFactory for the agent screen's RFB stream (ADR 0012) on
 * React Native's WebSocket (OkHttp). Binary frames cross React Native's bridge
 * as base64 in both directions; `binaryType` 'arraybuffer' turns them back
 * into bytes. The URL is checked first and never logged or put in an error.
 */
export function createBinaryWebSocketFactory(options: {
  Socket: RnWebSocketConstructor
  /** Origin of the Hermes server the client is signed in to, if any. */
  hermesOrigin: () => string | undefined
}): BinaryWebSocketFactory {
  return (rawUrl) => {
    const check = checkDisplaySocketRequest(rawUrl, options.hermesOrigin())
    if (!check.ok) throw new Error(`Refused screen socket request (${check.reason})`)
    const socket = new options.Socket(check.url)
    socket.binaryType = 'arraybuffer'
    return adapt(socket)
  }
}
