// The browser's own Hermes client (Cindl mounted on its Hermes's origin):
// when it is chosen, what it keeps, and how it signs in. Synthetic data only.
import { CindlProvider } from '@cindl/client-react'
import { CindlError, type CindlClientApi, type LinkState } from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserBinarySocket,
  browserSocket,
  memoryStore,
} from '../src/platform/browser.ts'
import { hermesAtThisOrigin, resolveClient } from '../src/platform/client.ts'
import { ClientKindContext, type ClientKind } from '../src/platform/clientKind.ts'
import { SignIn } from '../src/shell/SignIn.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ORIGIN = 'https://hermes.example.test'
const status = (body: unknown, init: ResponseInit = { status: 200 }) =>
  Promise.resolve(new Response(JSON.stringify(body), init))
const HERMES = {
  version: '0.22.5',
  auth_required: true,
  auth_flows: ['cookie', 'native_pkce'],
}

describe('choosing the same-origin client', () => {
  it("asks this origin's public status, with the browser's own credentials only", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchStatus = (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return status(HERMES)
    }
    expect(await hermesAtThisOrigin(fetchStatus, ORIGIN)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/status`)
    expect(calls[0]?.init.credentials).toBe('same-origin')
    expect(calls[0]?.init.method ?? 'GET').toBe('GET')
  })

  it.each([
    [
      'a 404 (served somewhere else)',
      () => status({ detail: 'Not Found' }, { status: 404 }),
    ],
    ['a page, not JSON', () => Promise.resolve(new Response('<!doctype html>'))],
    ['a server that is not Hermes', () => status({ ok: true })],
    [
      'no cookie flow (native sign-in only)',
      () => status({ ...HERMES, auth_flows: ['native_pkce'] }),
    ],
    ['no version', () => status({ auth_flows: ['cookie'] })],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('is not chosen for %s', async (_name, answer) => {
    expect(await hermesAtThisOrigin(answer, ORIGIN)).toBe(false)
  })

  it('resolves to the Hermes client only when this origin is Hermes, never silently to anything else', async () => {
    vi.stubGlobal('location', { ...window.location, origin: ORIGIN })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => status(HERMES)),
    )
    const found = await resolveClient()
    expect(found.kind).toBe('hermes')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => status({ detail: 'Not Found' }, { status: 404 })),
    )
    expect((await resolveClient()).kind).toBe('unavailable')
  })

  it('stays unavailable on an origin Cindl does not accept for Hermes, even if it answers like Hermes', async () => {
    const fetch = vi.fn(() => status(HERMES))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:4173' })
    expect((await resolveClient()).kind).toBe('unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("the browser's device state", () => {
  it('lives in memory only: nothing reaches browser storage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem')
    const store = memoryStore()
    await store.set('cindl.outbox', '[]')
    expect(await store.get('cindl.outbox')).toBe('[]')
    await store.delete('cindl.outbox')
    expect(await store.get('cindl.outbox')).toBeUndefined()
    expect(local).not.toHaveBeenCalled()
    // A second page (a reload) starts empty.
    expect(await memoryStore().get('cindl.outbox')).toBeUndefined()
  })
})

class FakeSocket {
  static last: FakeSocket | undefined
  readyState = 0
  protocol = ''
  binaryType = 'blob'
  sent: unknown[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly url: string
  readonly protocols: string[] | undefined
  constructor(url: string, protocols?: string[]) {
    this.url = url
    this.protocols = protocols
    FakeSocket.last = this
  }
  send(data: unknown) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
}

describe('the sockets', () => {
  it('the gateway socket carries the ticket subprotocols and passes text frames through', () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    const like = browserSocket(`wss://hermes.example.test/api/ws`, [
      'hermes-gateway-v1',
      'hermes-gateway-ticket.synthetic',
    ])
    const raw = FakeSocket.last!
    expect(raw.protocols).toEqual([
      'hermes-gateway-v1',
      'hermes-gateway-ticket.synthetic',
    ])
    const seen: unknown[] = []
    like.onmessage = (event) => seen.push(event.data)
    raw.onmessage?.({ data: '{"jsonrpc":"2.0"}' })
    expect(seen).toEqual(['{"jsonrpc":"2.0"}'])
    like.send('{"id":1}')
    expect(raw.sent).toEqual(['{"id":1}'])
  })

  it('the screen socket reads binary frames as bytes, drops text frames, and sends a copy', () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    const like = browserBinarySocket('wss://hermes.example.test/api/display/ws')
    const raw = FakeSocket.last!
    expect(raw.binaryType).toBe('arraybuffer')
    const seen: Uint8Array[] = []
    like.onmessage = (event) => seen.push(event.data)
    raw.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer })
    raw.onmessage?.({ data: 'not part of the stream' })
    expect(seen.map((bytes) => [...bytes])).toEqual([[1, 2, 3]])
    const bytes = new Uint8Array([9, 8])
    like.send(bytes)
    expect(raw.sent[0]).not.toBe(bytes)
    expect([...(raw.sent[0] as Uint8Array)]).toEqual([9, 8])
  })
})

describe('signing in when served by Hermes', () => {
  const link = (phase: LinkState['phase']): LinkState => ({
    phase,
    demo: false,
    since: '2026-11-03T09:00:00.000Z',
    connectionEpoch: 1,
  })
  function renderSignIn(kind: ClientKind, call: CindlClientApi['call']) {
    const api: CindlClientApi = {
      call,
      subscribe: (listener) => {
        listener({ type: 'link.changed', link: link('signed-out') } as never)
        return () => undefined
      },
    }
    render(
      <ClientKindContext value={kind}>
        <CindlProvider api={api}>
          <SignIn />
        </CindlProvider>
      </ClientKindContext>,
    )
  }

  it("sends the browser to Hermes's own login page and back to this exact place", () => {
    const assign = vi.fn()
    vi.stubGlobal('location', {
      ...window.location,
      origin: ORIGIN,
      pathname: '/cindl/',
      search: '',
      hash: '#/library/memory',
      assign,
    })
    renderSignIn('hermes', vi.fn() as never)
    expect(screen.queryByLabelText('Hermes address')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Hermes' }))
    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent('/cindl/#/library/memory')}`,
    )
  })

  it('checks again on request and shows why it is still signed out', async () => {
    vi.stubGlobal('location', { ...window.location, origin: ORIGIN })
    const call = vi.fn(() =>
      Promise.reject(
        new CindlError(
          'unauthenticated',
          'Sign in on the Hermes login page, then try again.',
        ),
      ),
    )
    renderSignIn('hermes', call)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(call).toHaveBeenCalledWith('auth.signIn', { origin: ORIGIN })
    expect(screen.getByRole('alert').textContent).toBe(
      'Sign in on the Hermes login page, then try again.',
    )
  })

  it('native clients keep the address form and the system browser', () => {
    renderSignIn('desktop', vi.fn() as never)
    expect(screen.getByLabelText('Hermes address')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in on Hermes' })).toBeNull()
  })
})
