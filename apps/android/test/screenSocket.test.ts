import { describe, expect, it } from 'vitest'
import {
  checkDisplaySocketRequest,
  createBinaryWebSocketFactory,
  type RnWebSocketLike,
} from '../src/platform/screenSocket.ts'

const HERMES = 'https://hermes.example.test'
const TICKET = ['synthetic', 'display', '0123'].join('-')
const SCREEN = `wss://hermes.example.test/api/display/ws?display_ticket=${TICKET}`

describe('screen socket request policy (desktop parity)', () => {
  it('accepts the screen socket on the signed-in origin with the ticket as its only query', () => {
    expect(checkDisplaySocketRequest(SCREEN, HERMES)).toEqual({ ok: true, url: SCREEN })
    const local = `ws://127.0.0.1:9119/api/display/ws?display_ticket=${TICKET}`
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
    [
      'plain ws to localhost (a name, not a loopback address)',
      `ws://localhost:9119/api/display/ws?display_ticket=${TICKET}`,
      'http://localhost:9119',
      'scheme',
    ],
    ['an https URL', SCREEN.replace('wss:', 'https:'), HERMES, 'scheme'],
    ['credentials', SCREEN.replace('//', '//user:pw@'), HERMES, 'credentials'],
    ['a fragment', `${SCREEN}#x`, HERMES, 'fragment'],
    ['the gateway path', SCREEN.replace('/display/ws', '/ws'), HERMES, 'path'],
    ['a longer path', SCREEN.replace('/ws?', '/ws/x?'), HERMES, 'path'],
    ['no ticket', 'wss://hermes.example.test/api/display/ws', HERMES, 'ticket'],
    ['an empty ticket', SCREEN.replace(TICKET, ''), HERMES, 'ticket'],
    ['a malformed ticket', SCREEN.replace(TICKET, 'a%20b%20c%20d'), HERMES, 'ticket'],
    ['two tickets', `${SCREEN}&display_ticket=${TICKET}`, HERMES, 'ticket'],
    ['another query parameter', `${SCREEN}&token=${TICKET}`, HERMES, 'ticket'],
    [
      'the ticket under another name',
      SCREEN.replace('display_ticket', 'ticket'),
      HERMES,
      'ticket',
    ],
    ['an unparseable URL', 'wss://', HERMES, 'unparseable'],
  ])('refuses %s', (_label, url, origin, reason) => {
    expect(checkDisplaySocketRequest(url, origin)).toEqual({ ok: false, reason })
  })
})

/** React Native's WebSocket as the factory sees it, driven by the test. */
class FakeRnSocket implements RnWebSocketLike {
  static opened: FakeRnSocket[] = []
  binaryType = 'blob'
  readyState = 0
  sent: unknown[] = []
  closed: Array<[number | undefined, string | undefined]> = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeRnSocket.opened.push(this)
  }
  send(data: ArrayBuffer | ArrayBufferView) {
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closed.push([code, reason])
  }
}

describe('React Native BinaryWebSocketFactory', () => {
  const factory = (origin: string | undefined = HERMES) =>
    createBinaryWebSocketFactory({ Socket: FakeRnSocket, hermesOrigin: () => origin })

  it('asks for array buffers and delivers every message as a plain Uint8Array', () => {
    FakeRnSocket.opened = []
    const socket = factory()(SCREEN)
    const raw = FakeRnSocket.opened[0]
    if (!raw) throw new Error('no socket opened')
    expect(raw.url).toBe(SCREEN)
    // React Native turns base64 binary frames into ArrayBuffers only in this mode.
    expect(raw.binaryType).toBe('arraybuffer')
    const messages: Uint8Array[] = []
    socket.onmessage = ({ data }) => messages.push(data)
    raw.onmessage?.({ data: Uint8Array.of(1, 2, 3).buffer })
    const shared = Uint8Array.of(9, 9, 4, 5, 6, 9)
    raw.onmessage?.({ data: shared.subarray(2, 5) })
    raw.onmessage?.({ data: 'RFB 003.008\n' })
    raw.onmessage?.({ data: { not: 'bytes' } })
    for (const data of messages)
      expect(Object.getPrototypeOf(data)).toBe(Uint8Array.prototype)
    expect(messages.map((data) => [...data])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [...new TextEncoder().encode('RFB 003.008\n')],
    ])
  })

  it('sends bytes as they are, and closes with the code given', () => {
    FakeRnSocket.opened = []
    const socket = factory()(SCREEN)
    const raw = FakeRnSocket.opened[0]
    if (!raw) throw new Error('no socket opened')
    const bytes = Uint8Array.of(3, 1, 0, 0)
    socket.send(bytes)
    expect(raw.sent).toEqual([bytes])
    raw.readyState = 1
    expect(socket.readyState).toBe(1)
    const closes: Array<{ code: number; reason: string }> = []
    socket.onclose = (event) => closes.push(event)
    socket.close(1000, 'unwatch')
    raw.onclose?.({ code: 1000 })
    expect(raw.closed).toEqual([[1000, 'unwatch']])
    expect(closes).toEqual([{ code: 1000, reason: '' }])
  })

  it('reports an error without its details, which can echo the URL', () => {
    FakeRnSocket.opened = []
    const socket = factory()(SCREEN)
    const reported: unknown[] = []
    socket.onerror = (event) => reported.push(event)
    FakeRnSocket.opened[0]?.onerror?.({ message: `failed to connect to ${SCREEN}` })
    expect(reported).toEqual([{ type: 'error' }])
    expect(JSON.stringify(reported)).not.toContain(TICKET)
  })

  it('throws before connecting, without the ticket, when the request breaks the policy', () => {
    FakeRnSocket.opened = []
    const attempt = (url: string, origin?: string) => {
      try {
        factory(origin)(url)
        return 'opened'
      } catch (error) {
        return (error as Error).message
      }
    }
    const refused = attempt(SCREEN.replace('hermes.', 'evil.'))
    expect(refused).toMatch(/origin/)
    expect(refused).not.toContain(TICKET)
    expect(attempt(SCREEN.replace('/display/ws', '/ws'))).toMatch(/path/)
    expect(
      (() => {
        try {
          createBinaryWebSocketFactory({
            Socket: FakeRnSocket,
            hermesOrigin: () => undefined,
          })(SCREEN)
          return 'opened'
        } catch (error) {
          return (error as Error).message
        }
      })(),
    ).toMatch(/not-signed-in/)
    expect(FakeRnSocket.opened).toEqual([])
  })
})
