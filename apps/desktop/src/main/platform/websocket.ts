import type {
  BinaryWebSocketFactory,
  BinaryWebSocketLike,
  WebSocketFactory,
  WebSocketLike,
} from '@cindl/client-core'
import { GATEWAY_SUBPROTOCOL, wsPaths } from '@cindl/hermes-adapter'
import WebSocket from 'ws'
import { usesSecureTransport } from './origin-policy.ts'

const TICKET_PREFIX = 'hermes-gateway-ticket.'
// RFC 6455 subprotocols are HTTP tokens; Hermes tickets are URL-safe strings.
const TICKET = /^[A-Za-z0-9._~-]{8,512}$/
const SECRET_QUERY = /^(?:ticket|token|access_token|refresh_token|code)$/i
const DISPLAY_TICKET = 'display_ticket'

/** Largest single message Cindl accepts from Hermes (after decompression). */
export const MAX_WS_PAYLOAD = 16 * 1024 * 1024

/**
 * Checks a WebSocket request before anything is sent. The socket may only go
 * to the signed-in Hermes origin (wss for https, ws for http), must offer the
 * gateway subprotocol, and may carry the single-use ticket only as the
 * `hermes-gateway-ticket.<ticket>` subprotocol: never in the URL, where it
 * would land in proxy and access logs.
 */
export function checkSocketRequest(
  rawUrl: string,
  protocols: readonly string[],
  hermesOrigin: string | undefined,
): { ok: true; url: string } | { ok: false; reason: string } {
  const target = checkTarget(rawUrl, hermesOrigin)
  if (!target.ok) return target
  const { url } = target
  for (const key of url.searchParams.keys())
    if (SECRET_QUERY.test(key)) return { ok: false, reason: 'secret-in-url' }
  if (protocols[0] !== GATEWAY_SUBPROTOCOL) return { ok: false, reason: 'subprotocol' }
  const extra = protocols.slice(1)
  if (
    extra.length > 1 ||
    extra.some(
      (protocol) =>
        !protocol.startsWith(TICKET_PREFIX) ||
        !TICKET.test(protocol.slice(TICKET_PREFIX.length)),
    )
  )
    return { ok: false, reason: 'subprotocol' }
  return { ok: true, url: url.href }
}

/** The checks both sockets share: the signed-in origin's host, over ws for http and wss for https. */
function checkTarget(
  rawUrl: string,
  hermesOrigin: string | undefined,
): { ok: true; url: URL } | { ok: false; reason: string } {
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
  if (url.protocol !== expectedProtocol || !usesSecureTransport(url))
    return { ok: false, reason: 'scheme' }
  if (url.host !== origin.host) return { ok: false, reason: 'origin' }
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'credentials' }
  if (url.hash !== '') return { ok: false, reason: 'fragment' }
  return { ok: true, url }
}

/**
 * Checks a screen socket request before anything is sent. Hermes's screen
 * socket takes its single-use ticket only in the query (noVNC cannot set a
 * header or subprotocol, ADR 0012), so the URL is a secret: it may go only to
 * `/api/display/ws` on the signed-in origin, with the ticket as its one
 * query parameter.
 */
export function checkDisplaySocketRequest(
  rawUrl: string,
  hermesOrigin: string | undefined,
): { ok: true; url: string } | { ok: false; reason: string } {
  const target = checkTarget(rawUrl, hermesOrigin)
  if (!target.ok) return target
  const { url } = target
  if (url.pathname !== wsPaths.display) return { ok: false, reason: 'path' }
  const keys = [...url.searchParams.keys()]
  const ticket = url.searchParams.get(DISPLAY_TICKET)
  if (keys.length !== 1 || keys[0] !== DISPLAY_TICKET || !ticket || !TICKET.test(ticket))
    return { ok: false, reason: 'ticket' }
  return { ok: true, url: url.href }
}

/** Text frames arrive as one Buffer with ws's default binaryType; decode them as UTF-8. */
function toText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Buffer.from(data).toString('utf8')
}

/** Adapts a `ws` socket to client-core's `WebSocketLike` (text frames become strings). */
function adapt(socket: WebSocket): WebSocketLike {
  const like: WebSocketLike = {
    get readyState() {
      return socket.readyState
    },
    get protocol() {
      return socket.protocol
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  socket.on('open', () => like.onopen?.({ type: 'open' }))
  socket.on('message', (data, isBinary) =>
    like.onmessage?.({ data: isBinary ? data : toText(data) }),
  )
  socket.on('close', (code, reason) =>
    like.onclose?.({ code, reason: reason.toString('utf8') }),
  )
  // Always listen: an unhandled 'error' event would crash the main process.
  // The error text is not forwarded: it can echo the request.
  socket.on('error', () => like.onerror?.({ type: 'error' }))
  return like
}

/**
 * `WebSocketFactory` for the direct Hermes client, on the `ws` package (the
 * main process has no browser WebSocket). Redirects are not followed and
 * payloads are capped.
 */
export function createWebSocketFactory(options: {
  /** Origin of the signed-in `hermes serve` backend, if any. */
  hermesOrigin: () => string | undefined
  handshakeTimeoutMs?: number
  maxPayload?: number
}): WebSocketFactory {
  return (rawUrl, protocols) => {
    const check = checkSocketRequest(rawUrl, protocols, options.hermesOrigin())
    if (!check.ok) throw new Error(`Refused WebSocket request (${check.reason})`)
    const socket = new WebSocket(check.url, [...protocols], {
      handshakeTimeout: options.handshakeTimeoutMs ?? 15_000,
      maxPayload: options.maxPayload ?? MAX_WS_PAYLOAD,
      followRedirects: false,
    })
    return adapt(socket)
  }
}

/** Any `ws` message as a plain Uint8Array over the same memory (not a Buffer, not a copy). */
function toBytes(data: WebSocket.RawData): Uint8Array {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : data
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/** Adapts a `ws` socket to client-core's `BinaryWebSocketLike`: every message arrives as bytes. */
function adaptBinary(socket: WebSocket): BinaryWebSocketLike {
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
  socket.on('open', () => like.onopen?.({ type: 'open' }))
  socket.on('message', (data) => like.onmessage?.({ data: toBytes(data) }))
  socket.on('close', (code, reason) =>
    like.onclose?.({ code, reason: reason.toString('utf8') }),
  )
  // As above: always listen, and never forward the error text (it can echo the URL).
  socket.on('error', () => like.onerror?.({ type: 'error' }))
  return like
}

/**
 * `BinaryWebSocketFactory` for the agent screen's RFB stream (ADR 0012), on
 * `ws`. Its URL carries the single-use display ticket, so it is checked first
 * (`checkDisplaySocketRequest`) and never logged or put in an error message.
 * Like the gateway socket: no Origin header, no redirects, capped payloads.
 */
export function createBinaryWebSocketFactory(options: {
  /** Origin of the signed-in `hermes serve` backend, if any. */
  hermesOrigin: () => string | undefined
  handshakeTimeoutMs?: number
  maxPayload?: number
}): BinaryWebSocketFactory {
  return (rawUrl) => {
    const check = checkDisplaySocketRequest(rawUrl, options.hermesOrigin())
    if (!check.ok) throw new Error(`Refused screen socket request (${check.reason})`)
    const socket = new WebSocket(check.url, {
      handshakeTimeout: options.handshakeTimeoutMs ?? 15_000,
      maxPayload: options.maxPayload ?? MAX_WS_PAYLOAD,
      followRedirects: false,
    })
    socket.binaryType = 'nodebuffer'
    return adaptBinary(socket)
  }
}
