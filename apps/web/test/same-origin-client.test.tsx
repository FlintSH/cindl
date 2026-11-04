// The browser's own Hermes client (Cindl mounted on its Hermes's origin):
// when it is chosen, what it keeps, how it signs in and starts, and what it
// says when it cannot connect. Synthetic data only.
import { CindlProvider } from '@cindl/client-react'
import {
  CindlError,
  type CindlClientApi,
  type CindlEvent,
  type LinkState,
} from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  announceSignOut,
  announcingSignOut,
  browserBinarySocket,
  browserSessionCue,
  browserSocket,
  memoryStore,
  sameOriginFetch,
  SESSION_CHANNEL,
} from '../src/platform/browser.ts'
import {
  probeThisOrigin,
  resolveClient,
  returnPath,
  STATUS_TIMEOUT_MS,
} from '../src/platform/client.ts'
import { ClientKindContext, type ClientKind } from '../src/platform/clientKind.ts'
import { AppShell } from '../src/shell/AppShell.tsx'
import { NotConnected } from '../src/shell/NotConnected.tsx'
import { SignIn } from '../src/shell/SignIn.tsx'
import { forgetSignOut, signOutHere } from '../src/shell/session.ts'

afterEach(() => {
  cleanup()
  forgetSignOut()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** One turn of the event loop: long enough for a BroadcastChannel delivery. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 20))

const ORIGIN = 'https://hermes.example.test'
const status = (body: unknown, init: ResponseInit = { status: 200 }) =>
  Promise.resolve(new Response(JSON.stringify(body), init))
const HERMES = {
  version: '0.22.5',
  auth_required: true,
  auth_flows: ['cookie', 'native_pkce'],
}

describe("asking this origin's status", () => {
  it("asks this origin's public status, with the browser's own credentials only", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchStatus = (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return status(HERMES)
    }
    expect(await probeThisOrigin(fetchStatus, ORIGIN)).toBe('hermes')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/status`)
    expect(calls[0]?.init.credentials).toBe('same-origin')
    expect(calls[0]?.init.method ?? 'GET').toBe('GET')
  })

  it.each([
    [
      'a 404 that happens to look like Hermes',
      () => status(HERMES, { status: 404 }),
      'not-hermes',
    ],
    [
      'a 404 (served somewhere else)',
      () => status({ detail: 'Not Found' }, { status: 404 }),
      'not-hermes',
    ],
    [
      'a page, not JSON',
      () => Promise.resolve(new Response('<!doctype html>')),
      'not-hermes',
    ],
    ['a server that is not Hermes', () => status({ ok: true }), 'not-hermes'],
    ['no version', () => status({ auth_flows: ['cookie'] }), 'not-hermes'],
    [
      'a network error',
      () => Promise.reject(new TypeError('Failed to fetch')),
      'no-answer',
    ],
    ['a 502 while Hermes restarts', () => status({}, { status: 502 }), 'no-answer'],
    [
      'Hermes without the cookie flow',
      () => status({ ...HERMES, auth_flows: ['native_pkce'] }),
      'no-sign-in',
    ],
    [
      'Hermes still starting (no flows yet)',
      () => status({ ...HERMES, auth_flows: [] }),
      'no-sign-in',
    ],
  ] as const)('tells %s apart', async (_name, answer, expected) => {
    expect(await probeThisOrigin(answer, ORIGIN)).toBe(expected)
  })

  it('stops waiting after the timeout and calls it no answer', async () => {
    vi.useFakeTimers()
    let aborted = false
    const never = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    const answer = probeThisOrigin(never, ORIGIN)
    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS - 1)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(aborted).toBe(true)
    expect(await answer).toBe('no-answer')
  })
})

describe('choosing the client', () => {
  it('uses the Hermes client only when this origin is Hermes, and says why otherwise', async () => {
    vi.stubGlobal('location', { ...window.location, origin: ORIGIN })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => status(HERMES)),
    )
    expect((await resolveClient()).kind).toBe('hermes')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => status({ detail: 'Not Found' }, { status: 404 })),
    )
    expect(await resolveClient()).toEqual({ kind: 'unavailable', reason: 'not-mounted' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => status({}, { status: 503 })),
    )
    expect(await resolveClient()).toEqual({ kind: 'unavailable', reason: 'no-answer' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => status({ ...HERMES, auth_flows: [] })),
    )
    expect(await resolveClient()).toEqual({ kind: 'unavailable', reason: 'no-sign-in' })
  })

  it('never asks an origin Cindl does not accept for Hermes, even one that answers like Hermes', async () => {
    const fetch = vi.fn(() => status(HERMES))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:4173' })
    expect(await resolveClient()).toEqual({
      kind: 'unavailable',
      reason: 'insecure-origin',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("the browser's device state and requests", () => {
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

  it("sends the browser's cookie by default, and never overrides a caller's choice", async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) => status({}))
    vi.stubGlobal('fetch', fetch)
    await sameOriginFetch(`${ORIGIN}/api/status`)
    await sameOriginFetch(`${ORIGIN}/api/status`, { credentials: 'omit' })
    expect(fetch.mock.calls.map((call) => call[1]?.credentials)).toEqual([
      'same-origin',
      'omit',
    ])
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

  it("both sockets pass Hermes's close code and reason on, so 4000 is never a mere drop", () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    const closes: Array<{ code: number; reason: string }> = []
    const gateway = browserSocket('wss://hermes.example.test/api/ws', [])
    gateway.onclose = (event) => closes.push(event)
    FakeSocket.last!.onclose?.({ code: 4000, reason: 'incompatible' })
    const screenSocket = browserBinarySocket('wss://hermes.example.test/api/display/ws')
    screenSocket.onclose = (event) => closes.push(event)
    FakeSocket.last!.onclose?.({ code: 4000, reason: 'control-taken' })
    expect(closes).toEqual([
      { code: 4000, reason: 'incompatible' },
      { code: 4000, reason: 'control-taken' },
    ])
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
  const at = (href: string) => {
    const url = new URL(href)
    const assign = vi.fn()
    vi.stubGlobal('location', {
      ...window.location,
      href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      assign,
    })
    return assign
  }

  it("sends the browser to Hermes's own login page and back to this exact view", () => {
    const assign = at(`${ORIGIN}/cindl/#/library/memory`)
    renderSignIn('hermes', vi.fn() as never)
    expect(screen.getByRole('heading', { name: 'Sign in to Hermes' })).toBeTruthy()
    expect(screen.queryByLabelText('Hermes address')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Hermes' }))
    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent('/cindl/#/library/memory')}`,
    )
  })

  it('returns to the mount and the view only, never a query or another file', () => {
    at(`${ORIGIN}/cindl/index.html?utm=x#/talk`)
    expect(returnPath()).toBe('/cindl/#/talk')
  })

  it('brings a view back the same however often Hermes decodes the return', () => {
    const assign = at(`${ORIGIN}/cindl/#/library/memory`)
    renderSignIn('hermes', vi.fn() as never)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Hermes' }))
    const next =
      new URL(assign.mock.calls[0]?.[0] as string, ORIGIN).searchParams.get('next') ?? ''
    // Past the query's own parsing, Hermes decodes `next` twice more on a
    // password sign-in (routes.py:93-97, 171), and once more again through
    // /auth/login on an OAuth one (routes.py:224-231).
    const twice = decodeURIComponent(decodeURIComponent(next))
    expect(twice).toBe('/cindl/#/library/memory')
    expect(decodeURIComponent(twice)).toBe('/cindl/#/library/memory')
  })

  it('returns to the mount alone from a view whose address holds a %, which the two sign-in paths would bring back differently', () => {
    const assign = at(`${ORIGIN}/cindl/#/library/skills/notes%2Fdaily`)
    expect(returnPath()).toBe('/cindl/')
    renderSignIn('hermes', vi.fn() as never)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Hermes' }))
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/cindl/')}`)
  })

  it("returns to Hermes's own landing page from a mount whose path holds a %", () => {
    at(`${ORIGIN}/cindl%2Fx/#/talk`)
    expect(returnPath()).toBe('/')
  })

  it('offers to sign out on Hermes again until Hermes confirms it', async () => {
    const outcomes = [false, false, true]
    const call = vi.fn((name: string) =>
      name === 'auth.signOut'
        ? Promise.resolve({ localOnly: true, hermesConfirmed: outcomes.shift() })
        : Promise.reject(new Error(`unexpected ${name}`)),
    )
    const api = call as unknown as CindlClientApi['call']
    // The device page's sign-out, which Hermes did not confirm.
    await signOutHere({ call: api, subscribe: () => () => undefined })
    renderSignIn('hermes', api)
    expect(screen.getByText(/Hermes has not confirmed the sign-out/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out on Hermes' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Still not confirmed: the offer stays, ready for another try.
    const again = screen.getByRole('button', { name: 'Sign out on Hermes' })
    expect(again.hasAttribute('disabled')).toBe(false)
    fireEvent.click(again)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: 'Sign out on Hermes' })).toBeNull()
    expect(screen.queryByText(/has not confirmed/)).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(
      'Hermes cleared its session cookie in this browser.',
    )
    expect(call.mock.calls.filter(([name]) => name === 'auth.signOut')).toHaveLength(3)
  })

  it('offers no second sign-out after one Hermes confirmed, or one with nothing to confirm', async () => {
    for (const result of [
      { localOnly: true, hermesConfirmed: true },
      { localOnly: true },
    ]) {
      const call = (() => Promise.resolve(result)) as unknown as CindlClientApi['call']
      await signOutHere({ call, subscribe: () => () => undefined })
      renderSignIn('hermes', call)
      expect(screen.queryByRole('button', { name: 'Sign out on Hermes' })).toBeNull()
      expect(screen.queryByText(/has not confirmed/)).toBeNull()
      cleanup()
    }
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

describe("the browser's session cue", () => {
  it('asks for a check when the page becomes visible again, or another tab signs out', async () => {
    const check = vi.fn()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const stop = browserSessionCue(check)
    try {
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(check).not.toHaveBeenCalled()
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(check).toHaveBeenCalledTimes(1)
      announceSignOut()
      await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    } finally {
      stop()
    }
  })

  it('without BroadcastChannel, still checks when the page comes back, and announces nothing', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const check = vi.fn()
    const stop = browserSessionCue(check)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(check).toHaveBeenCalledTimes(1)
    expect(() => announceSignOut()).not.toThrow()
    stop()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('takes nothing else on the channel for a cue, and goes quiet once unsubscribed', async () => {
    const check = vi.fn()
    const stop = browserSessionCue(check)
    const other = new BroadcastChannel(SESSION_CHANNEL)
    try {
      other.postMessage('hello')
      await nextTask()
      expect(check).not.toHaveBeenCalled()
      stop()
      other.postMessage('signed-out')
      document.dispatchEvent(new Event('visibilitychange'))
      await nextTask()
      expect(check).not.toHaveBeenCalled()
    } finally {
      other.close()
    }
  })

  it('tells the other tabs once a sign-out here settles, succeeded or not, and after nothing else', async () => {
    const heard: unknown[] = []
    const tabs = new BroadcastChannel(SESSION_CHANNEL)
    tabs.addEventListener('message', (event) => heard.push(event.data))
    const client = (signOut: () => Promise<unknown>) =>
      announcingSignOut({
        start: () => Promise.resolve(),
        stop: () => undefined,
        subscribe: () => () => undefined,
        call: ((name: string) =>
          name === 'auth.signOut'
            ? signOut()
            : Promise.resolve([])) as unknown as CindlClientApi['call'],
      })
    try {
      const signsOut = client(() =>
        Promise.resolve({ localOnly: true, hermesConfirmed: true }),
      )
      await signsOut.call('conversations.list', {})
      await nextTask()
      expect(heard).toEqual([])
      expect(await signsOut.call('auth.signOut', {})).toEqual({
        localOnly: true,
        hermesConfirmed: true,
      })
      await vi.waitFor(() => expect(heard).toEqual(['signed-out']))
      const fails = client(() => Promise.reject(new Error('Keychain locked.')))
      await expect(fails.call('auth.signOut', {})).rejects.toThrow('Keychain locked.')
      await vi.waitFor(() => expect(heard).toEqual(['signed-out', 'signed-out']))
    } finally {
      tabs.close()
    }
  })
})

describe('"Check again" in the shell', () => {
  it('keeps the sign-in screen while the client connects, and shows why it is still signed out', async () => {
    window.history.replaceState(null, '', '#/agent/device')
    vi.stubGlobal('location', { ...window.location, origin: ORIGIN })
    const listeners = new Set<(event: CindlEvent) => void>()
    const link = (phase: LinkState['phase']) =>
      act(async () => {
        for (const listener of listeners)
          listener({
            type: 'link.changed',
            link: {
              phase,
              demo: false,
              since: new Date().toISOString(),
              connectionEpoch: 3,
            },
          })
        await Promise.resolve()
      })
    let answer: (() => void) | undefined
    const api: CindlClientApi = {
      call: ((name: string) => {
        if (name !== 'auth.signIn') return Promise.resolve([])
        // As the direct client does: it says it is connecting, then Hermes refuses.
        void link('connecting')
        return new Promise((_, reject) => {
          answer = () =>
            reject(
              new CindlError(
                'unauthenticated',
                'Sign in on the Hermes login page, then try again.',
              ),
            )
        })
      }) as unknown as CindlClientApi['call'],
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    render(
      <ClientKindContext value="hermes">
        <CindlProvider api={api}>
          <AppShell />
        </CindlProvider>
      </ClientKindContext>,
    )
    await link('signed-out')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await act(async () => {
      await Promise.resolve()
    })
    // Connecting, and still the sign-in screen, its check out.
    expect(screen.getByRole('heading', { name: 'Sign in to Hermes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeTruthy()
    // Refused, as the client reports it: the link is signed out, then the call fails.
    await link('signed-out')
    await act(async () => {
      answer?.()
      await Promise.resolve()
    })
    expect(screen.getByRole('alert').textContent).toBe(
      'Sign in on the Hermes login page, then try again.',
    )
  })
})

describe('an unconfirmed sign-out in the shell', () => {
  it('is forgotten once the page is online again', async () => {
    window.history.replaceState(null, '', '#/talk')
    // jsdom has no matchMedia: a narrow window.
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: false,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    const scenario = createScenarioClient({ speed: 0 })
    const listeners = new Set<(event: CindlEvent) => void>()
    const api: CindlClientApi = {
      call: ((name: never, args: never) =>
        name === 'auth.signOut'
          ? Promise.resolve({ localOnly: true, hermesConfirmed: false })
          : scenario.call(name, args)) as CindlClientApi['call'],
      subscribe: (listener) => {
        listeners.add(listener)
        const off = scenario.subscribe(listener)
        return () => {
          listeners.delete(listener)
          off()
        }
      },
    }
    render(
      <ClientKindContext value="hermes">
        <CindlProvider api={api}>
          <AppShell />
        </CindlProvider>
      </ClientKindContext>,
    )
    const emit = (phase: LinkState['phase']) =>
      act(async () => {
        for (const listener of listeners)
          listener({
            type: 'link.changed',
            link: {
              phase,
              demo: false,
              since: new Date().toISOString(),
              connectionEpoch: 2,
            },
          })
        await Promise.resolve()
      })
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve()
    })
    await signOutHere(api)
    await emit('signed-out')
    expect(screen.getByRole('button', { name: 'Sign out on Hermes' })).toBeTruthy()
    await emit('online')
    await emit('signed-out')
    expect(screen.getByRole('button', { name: 'Sign in on Hermes' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign out on Hermes' })).toBeNull()
  })
})

describe('when the page cannot connect', () => {
  it.each([
    ['not-mounted', 'Cindl is not connected', false],
    ['no-answer', 'Hermes did not answer', true],
    ['no-sign-in', 'Hermes offers no sign-in for browsers', true],
    ['insecure-origin', 'Cindl is not connected', false],
  ] as const)(
    'says what %s means, offering Try again only when it may pass',
    (reason, title, retry) => {
      const onRetry = vi.fn()
      render(<NotConnected reason={reason} onRetry={onRetry} />)
      expect(screen.getByRole('heading', { name: title })).toBeTruthy()
      const again = screen.queryByRole('button', { name: 'Try again' })
      expect(Boolean(again)).toBe(retry)
      if (again) {
        fireEvent.click(again)
        expect(onRetry).toHaveBeenCalledTimes(1)
      }
    },
  )
})

describe('starting the client', () => {
  it('subscribes before the client starts, retries after no answer, and stops on unmount', async () => {
    const order: string[] = []
    const fake = {
      call: vi.fn(),
      subscribe: (listener: (event: CindlEvent) => void) => {
        order.push('subscribe')
        void listener
        return () => order.push('unsubscribe')
      },
      start: () => {
        order.push('start')
        return Promise.resolve()
      },
      stop: () => order.push('stop'),
    }
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'no-answer' })
      .mockResolvedValueOnce({ kind: 'hermes', api: fake })
    vi.doMock('../src/platform/client.ts', async (actual) => ({
      ...(await actual<typeof import('../src/platform/client.ts')>()),
      resolveClient: resolve,
    }))
    vi.doMock('../src/shell/AppShell.tsx', () => ({ AppShell: () => null }))
    const { App } = await import('../src/App.tsx')
    const view = render(<App />)
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['subscribe', 'start'])
    view.unmount()
    expect(order).toEqual(['subscribe', 'start', 'stop', 'unsubscribe'])
    vi.doUnmock('../src/platform/client.ts')
    vi.doUnmock('../src/shell/AppShell.tsx')
  })
})
