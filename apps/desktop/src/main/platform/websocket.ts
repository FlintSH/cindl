import type { WebSocketFactory, WebSocketLike } from '@cindl/client-core'
import { GATEWAY_SUBPROTOCOL } from '@cindl/hermes-adapter'
import WebSocket from 'ws'
import { usesSecureTransport } from './origin-policy.ts'

const TICKET_PREFIX = 'hermes-gateway-ticket.'
// RFC 6455 subprotocols are HTTP tokens; Hermes tickets are URL-safe strings.
const TICKET = /^[A-Za-z0-9._~-]{8,512}$/
const SECRET_QUERY = /^(?:ticket|token|access_token|refresh_token|code)$/i

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
