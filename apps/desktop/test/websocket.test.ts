import type { WebSocketLike } from '@cindl/client-core'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  checkSocketRequest,
  createWebSocketFactory,
} from '../src/main/platform/websocket.ts'

// Assembled at runtime so no ticket-shaped value is committed.
const TICKET = ['hermes-gateway-ticket', 'synthetic-ticket-0123456789'].join('.')
const HERMES = 'https://hermes.example.test'

describe('WebSocket request policy', () => {
  it('accepts the gateway URL with the ticket only as a subprotocol', () => {
    expect(
      checkSocketRequest(
        `wss://hermes.example.test/api/ws`,
        ['hermes-gateway-v1', TICKET],
        HERMES,
      ),
    ).toEqual({ ok: true, url: 'wss://hermes.example.test/api/ws' })
    expect(
      checkSocketRequest(
        'ws://127.0.0.1:9119/api/ws',
        ['hermes-gateway-v1'],
        'http://127.0.0.1:9119',
      ),
    ).toEqual({ ok: true, url: 'ws://127.0.0.1:9119/api/ws' })
  })

  it.each([
    [
      'not signed in',
      'wss://hermes.example.test/api/ws',
      ['hermes-gateway-v1', TICKET],
      undefined,
      'not-signed-in',
    ],
    [
      'a ticket in the query',
      'wss://hermes.example.test/api/ws?ticket=abcdefgh',
      ['hermes-gateway-v1'],
      HERMES,
      'secret-in-url',
    ],
    [
      'a token in the query',
      'wss://hermes.example.test/api/ws?access_token=abcdefgh',
      ['hermes-gateway-v1'],
      HERMES,
      'secret-in-url',
    ],
    [
      'another host',
      'wss://evil.example.test/api/ws',
      ['hermes-gateway-v1', TICKET],
      HERMES,
      'origin',
    ],
    [
      'another port',
      'wss://hermes.example.test:8443/api/ws',
      ['hermes-gateway-v1', TICKET],
      HERMES,
      'origin',
    ],
    [
      'plain ws for an https origin',
      'ws://hermes.example.test/api/ws',
      ['hermes-gateway-v1', TICKET],
      HERMES,
      'scheme',
    ],
    [
      'plain ws off-device',
      'ws://hermes.example.test/api/ws',
      ['hermes-gateway-v1'],
      'http://hermes.example.test',
      'scheme',
    ],
    [
      'credentials',
      'wss://user:pw@hermes.example.test/api/ws',
      ['hermes-gateway-v1'],
      HERMES,
      'credentials',
    ],
    [
      'a fragment',
      'wss://hermes.example.test/api/ws#x',
      ['hermes-gateway-v1'],
      HERMES,
      'fragment',
    ],
    [
      'no gateway subprotocol',
      'wss://hermes.example.test/api/ws',
      [TICKET],
      HERMES,
      'subprotocol',
    ],
    [
      'an extra subprotocol',
      'wss://hermes.example.test/api/ws',
      ['hermes-gateway-v1', 'chat'],
      HERMES,
      'subprotocol',
    ],
    [
      'two tickets',
      'wss://hermes.example.test/api/ws',
      ['hermes-gateway-v1', TICKET, TICKET],
      HERMES,
      'subprotocol',
    ],
    [
      'a malformed ticket',
      'wss://hermes.example.test/api/ws',
      ['hermes-gateway-v1', 'hermes-gateway-ticket.a b'],
      HERMES,
      'subprotocol',
    ],
    [
      'an https URL',
      'https://hermes.example.test/api/ws',
      ['hermes-gateway-v1'],
      HERMES,
      'scheme',
    ],
  ])('refuses %s', (_label, url, protocols, origin, reason) => {
    expect(checkSocketRequest(url, protocols, origin)).toEqual({ ok: false, reason })
  })
})

describe('ws-based WebSocketFactory', () => {
  let server: WebSocketServer | undefined
  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve()
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
        server = undefined
      }),
  )

  it('offers the gateway and ticket subprotocols, keeps the URL clean and decodes text frames', async () => {
    const seen: { url?: string; protocols?: string[] } = {}
    server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      handleProtocols: (protocols) => {
        seen.protocols = [...protocols]
        return 'hermes-gateway-v1'
      },
    })
    server.on('connection', (socket, request) => {
      if (request.url) seen.url = request.url
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { type: 'gateway.ready' },
        }),
      )
      socket.on('message', (data: Buffer) => socket.send(`echo:${data.toString('utf8')}`))
    })
    await new Promise<void>((resolve) => server?.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${port}`
    const factory = createWebSocketFactory({ hermesOrigin: () => origin })
    const socket: WebSocketLike = factory(`ws://127.0.0.1:${port}/api/ws`, [
      'hermes-gateway-v1',
      TICKET,
    ])
    const messages: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error('socket error'))
      socket.onopen = () => socket.send('ping')
      socket.onmessage = ({ data }) => {
        messages.push(data)
        if (messages.length === 2) resolve()
      }
    })
    expect(socket.protocol).toBe('hermes-gateway-v1')
    expect(seen.protocols).toEqual(['hermes-gateway-v1', TICKET])
    expect(seen.url).toBe('/api/ws')
    expect(typeof messages[0]).toBe('string')
    expect(messages[1]).toBe('echo:ping')
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.onclose = resolve
    })
    socket.close(1000, 'done')
    expect((await closed).code).toBe(1000)
  })

  it('throws before connecting when the request breaks the policy', () => {
    const factory = createWebSocketFactory({ hermesOrigin: () => HERMES })
    expect(() =>
      factory('wss://hermes.example.test/api/ws?ticket=abcdefgh', ['hermes-gateway-v1']),
    ).toThrow(/secret-in-url/)
    expect(() => factory('wss://hermes.example.test/api/ws', ['x'])).toThrow(
      /subprotocol/,
    )
  })
})
