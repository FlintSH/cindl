import {
  createDirectClient,
  type BinaryWebSocketFactory,
  type BinaryWebSocketLike,
  type Clock,
  type DirectClient,
  type KeyValueStore,
  type WebSocketFactory,
  type WebSocketLike,
} from '@cindl/client-core'

/**
 * The browser's client when Cindl is served from its Hermes's own origin (a
 * same-origin mount). It signs in with Hermes's session cookie, set by
 * Hermes's own login page: the cookie is HttpOnly, so no token is ever
 * visible here, and nothing is kept in browser storage. Device state (the
 * outbox, accepted prompt ids, the connection epoch) lives in memory for this
 * page only, so a reload starts from what Hermes holds.
 */
export function createSameOriginClient(origin: string): DirectClient {
  return createDirectClient({
    origin,
    auth: 'same-origin-cookie',
    // Same origin: the browser sends Hermes's cookie with every request.
    fetch: (url, init) => window.fetch(url, { ...init, credentials: 'same-origin' }),
    socketFactory: browserSocket,
    displaySocketFactory: browserBinarySocket,
    clock,
    kv: memoryStore(),
  })
}

/** Non-secret device state, in memory only: the web keeps nothing in browser storage. */
export function memoryStore(): KeyValueStore {
  const values = new Map<string, string>()
  return {
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
}

/** The gateway socket (JSON-RPC text frames), with the ticket subprotocol. */
export const browserSocket: WebSocketFactory = (url, protocols) => {
  const ws = new WebSocket(url, protocols)
  const like: WebSocketLike = {
    get readyState() {
      return ws.readyState
    },
    get protocol() {
      return ws.protocol
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.onopen = (event) => like.onopen?.(event)
  ws.onmessage = (event: MessageEvent) => like.onmessage?.({ data: event.data })
  ws.onclose = (event: CloseEvent) =>
    like.onclose?.({ code: event.code, reason: event.reason })
  ws.onerror = (event) => like.onerror?.(event)
  return like
}

/** The agent screen's socket: raw RFB bytes in binary frames (ADR 0012). */
export const browserBinarySocket: BinaryWebSocketFactory = (url) => {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const like: BinaryWebSocketLike = {
    get readyState() {
      return ws.readyState
    },
    // A copy, so the bytes sit in a plain ArrayBuffer as WebSocket.send needs.
    send: (data) => ws.send(new Uint8Array(data)),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.onopen = (event) => like.onopen?.(event)
  ws.onmessage = (event: MessageEvent) => {
    // Text frames are not part of the RFB stream; only bytes go through.
    if (event.data instanceof ArrayBuffer)
      like.onmessage?.({ data: new Uint8Array(event.data) })
  }
  ws.onclose = (event: CloseEvent) =>
    like.onclose?.({ code: event.code, reason: event.reason })
  ws.onerror = (event) => like.onerror?.(event)
  return like
}
