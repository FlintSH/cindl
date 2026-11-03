/**
 * TEST-ONLY WebSocket clients for the fake Hermes server.
 *
 * `nodeSocketFactory` adapts the `ws` client to the platform `WebSocketLike`
 * interface (client-core/src/platform.ts), optionally sending an Origin
 * header so tests can exercise Hermes's Origin check. `connectRawClient` is a
 * bare JSON-RPC peer standing in for another Hermes client (e.g. the desktop
 * app) attached to the same session.
 */
import type { WebSocketFactory, WebSocketLike } from '@cindl/client-core'
import WebSocket from 'ws'
import type { FakeSession } from './auth.ts'
import type { FakeHermes } from './server.ts'

export interface NodeSocketOptions {
  /** Origin header to send. Absent by default, like a native client. */
  origin?: string
}

export function nodeSocketFactory(options: NodeSocketOptions = {}): WebSocketFactory {
  return (url, protocols) => {
    const ws = new WebSocket(
      url,
      protocols,
      options.origin ? { origin: options.origin } : {},
    )
    const like: WebSocketLike = {
      get readyState() {
        return ws.readyState
      },
      get protocol() {
        return ws.protocol
      },
      send: (data) => ws.send(data),
      close: (code, reason) => {
        try {
          ws.close(code, reason)
        } catch {
          ws.terminate()
        }
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }
    ws.on('open', () => like.onopen?.({}))
    ws.on('message', (data, isBinary) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8')
      like.onmessage?.({ data: isBinary ? data : text })
    })
    ws.on('close', (code, reason) =>
      like.onclose?.({ code, reason: reason.toString('utf8') }),
    )
    ws.on('error', (error) => like.onerror?.(error))
    return like
  }
}

type Json = Record<string, unknown>

export interface RawClient {
  /** Frames received, in order. */
  readonly frames: Json[]
  request(method: string, params?: Json): Promise<Json>
  /** Reply to a server request by id. */
  send(frame: Json): void
  /** Resolve with the next server request (id + method + params) that arrives. */
  nextServerRequest(): Promise<{ id: string; method: string; params: Json }>
  close(): void
}

/** A second Hermes client on the fake, authenticated with a fresh ticket. */
export async function connectRawClient(
  fake: FakeHermes,
  session: FakeSession,
  options: { answersRequests?: boolean } = {},
): Promise<RawClient> {
  const response = await fetch(`${fake.origin}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` },
  })
  const { ticket } = (await response.json()) as { ticket: string }
  const ws = new WebSocket(`${fake.origin.replace('http', 'ws')}/api/ws`, [
    'hermes-gateway-v1',
    `hermes-gateway-ticket.${ticket}`,
  ])
  const frames: Json[] = []
  const pending = new Map<number, (frame: Json) => void>()
  const waiters: Array<(request: { id: string; method: string; params: Json }) => void> =
    []
  let nextId = 0
  ws.on('message', (data) => {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8')
    const frame = JSON.parse(text) as Json
    frames.push(frame)
    if (typeof frame.id === 'number') pending.get(frame.id)?.(frame)
    else if (typeof frame.id === 'string' && typeof frame.method === 'string')
      waiters.shift()?.({
        id: frame.id,
        method: frame.method,
        params: (frame.params ?? {}) as Json,
      })
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const client: RawClient = {
    frames,
    request(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve) => {
        pending.set(id, resolve)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    },
    send(frame) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
    },
    nextServerRequest() {
      return new Promise((resolve) => waiters.push(resolve))
    },
    close() {
      ws.terminate()
    },
  }
  if (options.answersRequests !== false)
    await client.request('client.capabilities', { server_requests: true })
  return client
}
