import type { BinaryWebSocketLike, WebSocketLike } from '@cindl/client-core'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  checkDisplaySocketRequest,
  checkSocketRequest,
  createBinaryWebSocketFactory,
  createWebSocketFactory,
} from '../src/main/platform/websocket.ts'

// Assembled at runtime so no ticket-shaped value is committed.
const TICKET = ['hermes-gateway-ticket', 'synthetic-ticket-0123456789'].join('.')
const DISPLAY = ['synthetic', 'display', '0123'].join('-')
const HERMES = 'https://hermes.example.test'
const SCREEN = `wss://hermes.example.test/api/display/ws?display_ticket=${DISPLAY}`

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

describe('screen socket request policy', () => {
  it('accepts the screen socket on the signed-in origin with the ticket as its only query', () => {
    expect(checkDisplaySocketRequest(SCREEN, HERMES)).toEqual({ ok: true, url: SCREEN })
    const local = `ws://127.0.0.1:9119/api/display/ws?display_ticket=${DISPLAY}`
    expect(checkDisplaySocketRequest(local, 'http://127.0.0.1:9119')).toEqual({
      ok: true,
      url: local,
    })
  })

  it.each([
    ['not signed in', SCREEN, undefined, 'not-signed-in'],
    ['another host', SCREEN.replace('hermes.', 'evil.'), HERMES, 'origin'],
    ['another port', SCREEN.replace('.test/', '.test:8443/'), HERMES, 'origin'],
    ['plain ws for an https origin', SCREEN.replace('wss:', 'ws:'), HERMES, 'scheme'],
    [
      'plain ws off-device',
      SCREEN.replace('wss:', 'ws:'),
      'http://hermes.example.test',
      'scheme',
    ],
    ['an https URL', SCREEN.replace('wss:', 'https:'), HERMES, 'scheme'],
    ['credentials', SCREEN.replace('//', '//user:pw@'), HERMES, 'credentials'],
    ['a fragment', `${SCREEN}#x`, HERMES, 'fragment'],
    ['the gateway path', SCREEN.replace('/display/ws', '/ws'), HERMES, 'path'],
    ['a longer path', SCREEN.replace('/ws?', '/ws/x?'), HERMES, 'path'],
    ['no ticket', 'wss://hermes.example.test/api/display/ws', HERMES, 'ticket'],
    ['an empty ticket', SCREEN.replace(DISPLAY, ''), HERMES, 'ticket'],
    ['a malformed ticket', SCREEN.replace(DISPLAY, 'a%20b%20c%20d'), HERMES, 'ticket'],
    ['two tickets', `${SCREEN}&display_ticket=${DISPLAY}`, HERMES, 'ticket'],
    ['another query parameter', `${SCREEN}&token=${DISPLAY}`, HERMES, 'ticket'],
    [
      'the ticket under another name',
      SCREEN.replace('display_ticket', 'ticket'),
      HERMES,
      'ticket',
    ],
  ])('refuses %s', (_label, url, origin, reason) => {
    expect(checkDisplaySocketRequest(url, origin)).toEqual({ ok: false, reason })
  })
})

describe('ws-based BinaryWebSocketFactory', () => {
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

  const listening = async (target: WebSocketServer) => {
    await new Promise<void>((resolve) => target.once('listening', resolve))
    return (target.address() as AddressInfo).port
  }

  it('delivers every message as a plain Uint8Array and sends bytes', async () => {
    const seen: { url?: string; headers?: IncomingHttpHeaders } = {}
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', (socket, request) => {
      if (request.url) seen.url = request.url
      seen.headers = request.headers
      socket.send(Uint8Array.of(1, 2, 3), { binary: true })
      socket.send('RFB 003.008\n')
      socket.on('message', (data: Buffer) => socket.send(data, { binary: true }))
    })
    const port = await listening(server)
    const factory = createBinaryWebSocketFactory({
      hermesOrigin: () => `http://127.0.0.1:${port}`,
    })
    const socket: BinaryWebSocketLike = factory(
      `ws://127.0.0.1:${port}/api/display/ws?display_ticket=${DISPLAY}`,
    )
    const messages: Uint8Array[] = []
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error('socket error'))
      socket.onopen = () => socket.send(Uint8Array.of(9, 8, 7))
      socket.onmessage = ({ data }) => {
        messages.push(data)
        if (messages.length === 3) resolve()
      }
    })
    // Not Buffers: the RFB client and IPC see plain bytes.
    for (const data of messages)
      expect(Object.getPrototypeOf(data)).toBe(Uint8Array.prototype)
    expect(messages.map((data) => [...data])).toEqual([
      [1, 2, 3],
      [...Buffer.from('RFB 003.008\n')],
      [9, 8, 7],
    ])
    // A native client: no subprotocol and no Origin header, the ticket only in the URL.
    expect(seen.url).toBe(`/api/display/ws?display_ticket=${DISPLAY}`)
    expect(seen.headers?.['sec-websocket-protocol']).toBeUndefined()
    expect(seen.headers?.origin).toBeUndefined()
    const closed = new Promise<{ code: number }>((resolve) => {
      socket.onclose = resolve
    })
    socket.close(1000, 'unwatch')
    expect((await closed).code).toBe(1000)
  })

  it('reports a failed connection without its URL', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const port = await listening(server)
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    const factory = createBinaryWebSocketFactory({
      hermesOrigin: () => `http://127.0.0.1:${port}`,
    })
    const socket = factory(
      `ws://127.0.0.1:${port}/api/display/ws?display_ticket=${DISPLAY}`,
    )
    const reported: unknown[] = []
    await new Promise<void>((resolve) => {
      socket.onerror = (event) => reported.push(event)
      socket.onclose = (event) => {
        reported.push(event)
        resolve()
      }
    })
    expect(reported).toEqual([{ type: 'error' }, expect.objectContaining({ code: 1006 })])
    expect(JSON.stringify(reported)).not.toContain(DISPLAY)
  })

  it('throws before connecting, without the ticket, when the request breaks the policy', () => {
    const factory = createBinaryWebSocketFactory({ hermesOrigin: () => HERMES })
    const attempt = (url: string) => {
      try {
        factory(url)
        return 'opened'
      } catch (error) {
        return (error as Error).message
      }
    }
    const refused = attempt(SCREEN.replace('hermes.', 'evil.'))
    expect(refused).toMatch(/origin/)
    expect(refused).not.toContain(DISPLAY)
    expect(attempt(SCREEN.replace('/display/ws', '/ws'))).toMatch(/path/)
    expect(() =>
      createBinaryWebSocketFactory({ hermesOrigin: () => undefined })(SCREEN),
    ).toThrow(/not-signed-in/)
  })
})

describe('redirects', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })

  /**
   * A Hermes stand-in on loopback that answers every WebSocket upgrade with a
   * redirect to a second loopback server, which counts who reaches it.
   */
  async function redirecting() {
    const target = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const reached = { count: 0 }
    target.on('connection', () => (reached.count += 1))
    await new Promise<void>((resolve) => target.once('listening', resolve))
    const targetPort = (target.address() as AddressInfo).port
    const server = createServer()
    server.on('upgrade', (request, socket) => {
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${targetPort}${request.url ?? '/'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of target.clients) client.terminate()
          target.close(() => resolve())
        }),
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    )
    const port = (server.address() as AddressInfo).port
    return { origin: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, reached }
  }

  /** How the socket ended up: never opened (closed) or opened after following. */
  const outcome = (socket: WebSocketLike | BinaryWebSocketLike) =>
    new Promise<'opened' | 'closed'>((resolve) => {
      socket.onopen = () => {
        socket.close(1000)
        resolve('opened')
      }
      socket.onclose = () => resolve('closed')
    })

  it('the gateway socket does not follow a redirect', async () => {
    const hermes = await redirecting()
    const socket = createWebSocketFactory({ hermesOrigin: () => hermes.origin })(
      `${hermes.ws}/api/ws`,
      ['hermes-gateway-v1', TICKET],
    )
    expect(await outcome(socket)).toBe('closed')
    expect(hermes.reached.count).toBe(0)
  })

  it('the screen socket does not follow a redirect', async () => {
    const hermes = await redirecting()
    const socket = createBinaryWebSocketFactory({ hermesOrigin: () => hermes.origin })(
      `${hermes.ws}/api/display/ws?display_ticket=${DISPLAY}`,
    )
    expect(await outcome(socket)).toBe('closed')
    expect(hermes.reached.count).toBe(0)
  })
})
