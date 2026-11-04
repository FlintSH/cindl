import { CindlError } from '@cindl/contracts'
import {
  FIXTURE_LOGIN,
  nodeBinarySocketFactory,
  nodeSocketFactory,
  type FakeHermes,
} from '@cindl/fixtures/fake-hermes'
import { loginPagePath, type FetchLike } from '@cindl/hermes-adapter'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  createDirectClient,
  createStore,
  entry,
  selectOpenRequests,
  systemClock,
  type DirectClientDeps,
} from '../src/index.ts'
import { fakeHermes, harness, memoryKv, type Harness } from './direct-harness.ts'

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof CindlError ? error : undefined),
  )

/**
 * A browser's cookie jar for one origin: it sends what Hermes set, unless the
 * request says `credentials: 'omit'`, and applies `Max-Age=0` deletions. Cindl
 * never sees these cookies; in a browser they are HttpOnly.
 */
function cookieJar(origin: string) {
  const jar = new Map<string, string>()
  /** `METHOD /path` of every request that carried the session cookies. */
  const sentWithCookie: string[] = []
  const jarFetch: FetchLike = async (url, init) => {
    const target = new URL(url)
    const headers = new Headers(init.headers)
    if (target.origin === origin && init.credentials !== 'omit' && jar.size) {
      headers.set(
        'Cookie',
        [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      )
      sentWithCookie.push(`${init.method ?? 'GET'} ${target.pathname}`)
    }
    const response = await fetch(url, { ...init, headers })
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      const deleted = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))
      if (deleted || !value) jar.delete(name)
      else jar.set(name, value)
    }
    return response
  }
  return { jar, fetch: jarFetch, sentWithCookie }
}

type Jar = ReturnType<typeof cookieJar>

/** What Hermes's login page does with the owner's password (login_page.py:401-430). */
async function passwordLogin(fake: FakeHermes, jar: Jar, next = '') {
  const response = await jar.fetch(`${fake.origin}/auth/password-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'basic', ...FIXTURE_LOGIN, next }),
    credentials: 'same-origin',
    redirect: 'manual',
  })
  return (await response.json()) as { ok: boolean; next: string }
}

/** The `next` the login page threads into its form, as the page's script reads it. */
async function formNext(fake: FakeHermes, path: string): Promise<string> {
  const page = await (await fetch(`${fake.origin}${path}`)).text()
  const value = /name="next" value="([^"]*)"/.exec(page)?.[1] ?? ''
  return value.replace(/&#(\d+);/g, (_, code: string) =>
    String.fromCharCode(Number(code)),
  )
}

/**
 * What the browser does on Hermes's OAuth path: the provider's link on the
 * login page, /auth/login, the IdP (the fake's stand-in approves at once) and
 * /auth/callback. Resolves where Hermes lands it.
 */
async function oauthLogin(fake: FakeHermes, jar: Jar, page: string): Promise<string> {
  const html = await (await fetch(`${fake.origin}${page}`)).text()
  const link = (/href="(\/auth\/login\?[^"]*)"/.exec(html)?.[1] ?? '').replace(
    /&#(\d+);/g,
    (_, code: string) => String.fromCharCode(Number(code)),
  )
  const start = await jar.fetch(`${fake.origin}${link}`, { redirect: 'manual' })
  const callback = start.headers.get('location') ?? ''
  const landed = await jar.fetch(`${fake.origin}${callback}`, { redirect: 'manual' })
  return landed.headers.get('location') ?? ''
}

/** A direct client in the web's mode: Hermes's same-origin cookie, nothing in storage. */
async function cookieClient(options: { screen?: boolean } = {}) {
  const fake = await fakeHermes()
  const jar = cookieJar(fake.origin)
  const h = await harness({
    fake,
    signIn: false,
    deps: {
      auth: 'same-origin-cookie',
      fetch: jar.fetch,
      ...(options.screen ? { displaySocketFactory: nodeBinarySocketFactory() } : {}),
    },
  })
  return { fake, jar, h }
}

async function signedIn(options: { screen?: boolean } = {}) {
  const { fake, jar, h } = await cookieClient(options)
  await passwordLogin(fake, jar)
  await h.client.call('auth.signIn', { origin: fake.origin })
  await h.waitFor(() => h.store.getState().link.phase === 'online')
  return { fake, jar, h }
}

function assistantText(h: Harness, conversationId: string): string {
  return (entry(h.store.getState().messages, conversationId) ?? [])
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
}

/** Requests the fake saw: REST as `METHOD /path`, sockets by path. */
const requests = (fake: FakeHermes, name: string) =>
  fake.calls.filter((c) => c.name === name).length

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, ms = 5_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('condition not met in time')
    await pause(10)
  }
}

/**
 * Two tabs of one browser: two cookie clients on one jar, both signed in.
 * `deps` go to both, `onlyB` to the second; `beforeB` runs once the first is
 * online, before the second starts.
 */
async function twoTabs(
  deps: Partial<DirectClientDeps> = {},
  onlyB: Partial<DirectClientDeps> = {},
  beforeB?: (fake: FakeHermes) => Promise<void>,
) {
  const fake = await fakeHermes()
  const jar = cookieJar(fake.origin)
  await passwordLogin(fake, jar)
  const tab = async (extra: Partial<DirectClientDeps>) => {
    const h = await harness({
      fake,
      signIn: false,
      deps: { auth: 'same-origin-cookie', fetch: jar.fetch, ...deps, ...extra },
    })
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    return h
  }
  const a = await tab({})
  await beforeB?.(fake)
  const b = await tab(onlyB)
  return { fake, jar, a, b }
}

/** A page's cue, fired by hand where a browser would fire visibilitychange. */
function pageCue() {
  const checks = new Set<() => void>()
  return {
    fire: () => {
      for (const check of checks) check()
    },
    get listening() {
      return checks.size
    },
    watchSession: (check: () => void) => {
      checks.add(check)
      return () => {
        checks.delete(check)
      }
    },
  }
}

/** The next turn waits on an approval; submit one in a new conversation and wait for its card. */
async function openApproval(h: Harness, fake: FakeHermes) {
  fake.gateway.script = async (turn) => {
    await turn.approval()
  }
  const c = await h.client.call('conversations.create', { title: 'Approval (fixture)' })
  await h.client.call('prompt.submit', {
    conversationId: c.id,
    clientId: `approval-${c.id}`,
    text: 'export it',
  })
  return h.waitFor(() => selectOpenRequests(h.store.getState())[0])
}

const requestStatus = (h: Harness, requestId: string) =>
  entry(h.store.getState().requests, requestId)?.status

/** The gate's answer once a browser session is over (middleware.py:72-87). */
const SESSION_EXPIRED = {
  error: 'session_expired',
  detail: 'Unauthorized',
  reason: 'invalid_or_expired_session',
  login_url: '/login',
}

describe('direct client in same-origin-cookie mode (the web)', () => {
  it('stays signed out, pointing at the Hermes login page, until the browser signs in', async () => {
    const { fake, h } = await cookieClient()
    await h.waitFor(() => h.store.getState().link.phase === 'signed-out')
    const refused = await failure(h.client.call('auth.signIn', { origin: fake.origin }))
    expect(refused?.code).toBe('unauthenticated')
    expect(refused?.message).toMatch(/Sign in on the Hermes login page/)
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      lastError: { code: 'unauthenticated' },
    })
    expect(requests(fake, '/api/ws')).toBe(0)
  })

  it('signs in after the login page and talks over a ticket fetched with the cookie', async () => {
    const { fake, jar, h } = await cookieClient()
    expect(await passwordLogin(fake, jar)).toEqual({ ok: true, next: '/' })
    expect([...jar.jar.keys()].sort()).toEqual([
      'hermes_session_at',
      'hermes_session_provider',
      'hermes_session_rt',
    ])
    await h.client.call('auth.signIn', { origin: fake.origin })
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    expect(jar.sentWithCookie).toContain('POST /api/auth/ws-ticket')
    expect(requests(fake, '/api/ws')).toBe(1)
    const c = await h.client.call('conversations.create', { title: 'Cookie (fixture)' })
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'cookie-1',
      text: 'Plan the week',
    })
    await h.waitFor(
      () => assistantText(h, c.id) === 'Synthetic reply (fixture) to: Plan the week',
    )
  })

  it('returns the browser to the page it left, escapes and query included', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    // Hermes decodes `next` at the page and again at the login (routes.py:93-97, 171).
    for (const next of ['/cindl/', '/cindl/c/a%2Fb%20c?q=1%262', '/cindl/%25']) {
      const carried = await formNext(fake, loginPagePath(next))
      expect(await passwordLogin(fake, jar, carried)).toEqual({ ok: true, next })
    }
    // An unsafe path never reaches the page; Hermes lands on its root.
    expect(loginPagePath('//elsewhere.invalid/')).toBe('/login')
    expect(await formNext(fake, loginPagePath('//elsewhere.invalid/'))).toBe('')
  })

  it('returns there through an OAuth provider too, unless next holds a %', async () => {
    const fake = await fakeHermes({
      providers: [
        { name: 'basic', supportsPassword: true },
        { name: 'portal', displayName: 'Portal (fixture)' },
      ],
    })
    const jar = cookieJar(fake.origin)
    for (const next of ['/cindl/', '/cindl/#/library/memory', '/cindl/c/1?q=a&b'])
      expect(await oauthLogin(fake, jar, loginPagePath(next))).toBe(next)
    // The OAuth path decodes once more (routes.py:224-231, 369-371), so an
    // escape in next comes back decoded; the password path keeps it.
    const escaped = '/cindl/#/library/skills/notes%2Fdaily'
    expect(await oauthLogin(fake, jar, loginPagePath(escaped))).toBe(
      '/cindl/#/library/skills/notes/daily',
    )
    const carried = await formNext(fake, loginPagePath(escaped))
    expect(await passwordLogin(fake, jar, carried)).toEqual({ ok: true, next: escaped })
  })

  it('reconnects with a fresh ticket, fetched with the cookie again', async () => {
    const { fake, jar, h } = await signedIn()
    const tickets = () =>
      jar.sentWithCookie.filter((c) => c === 'POST /api/auth/ws-ticket')
    const before = tickets().length
    fake.gateway.dropConnections()
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.connectionEpoch >= 2,
    )
    expect(tickets()).toHaveLength(before + 1)
    expect(requests(fake, '/api/ws')).toBe(2)
  })

  it('rotates an expired access cookie through the refresh cookie for a burst of calls', async () => {
    const { fake, jar, h } = await signedIn()
    const before = Object.fromEntries(jar.jar)
    fake.auth.expireAccessTokens()
    // The burst leaves with the same stale cookies; the gate rotates once and
    // serves every call (middleware.py:192-211, refresh_singleflight.py:1-11).
    await Promise.all([
      h.client.call('memory.overview', {}),
      h.client.call('skills.list', {}),
      h.client.call('memory.overview', {}),
    ])
    expect(jar.jar.get('hermes_session_at')).not.toBe(before.hermes_session_at)
    expect(jar.jar.get('hermes_session_rt')).not.toBe(before.hermes_session_rt)
    expect(h.store.getState().link.phase).toBe('online')
  })

  it('signs out through /auth/logout, after which Hermes answers 401', async () => {
    const { fake, jar, h } = await signedIn()
    expect(await h.client.call('auth.signOut', {})).toStrictEqual({
      localOnly: true,
      hermesConfirmed: true,
    })
    expect(requests(fake, 'POST /auth/logout')).toBe(1)
    expect(jar.sentWithCookie).toContain('POST /auth/logout')
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(h.events.some((e) => e.type === 'notice')).toBe(false)
    expect(jar.jar.size).toBe(0)
    expect((await jar.fetch(`${fake.origin}/api/auth/me`, {})).status).toBe(401)
  })

  it('signs out locally when Hermes does not confirm, and says so', async () => {
    const { fake, h } = await signedIn()
    fake.failNextRest('POST /auth/logout', 500)
    expect(await h.client.call('auth.signOut', {})).toStrictEqual({
      localOnly: true,
      hermesConfirmed: false,
    })
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(
      h.events.some(
        (e) =>
          e.type === 'notice' &&
          e.level === 'warning' &&
          /did not confirm the sign-out/.test(e.message),
      ),
    ).toBe(true)
  })

  it('goes signed out, and closes the socket, when Hermes ends the session', async () => {
    const { fake, jar, h } = await signedIn()
    // No token verifies any more, as when Hermes's signing secret changes.
    fake.auth.revokeAll()
    const refused = await failure(h.client.call('memory.overview', {}))
    expect(refused?.code).toBe('unauthenticated')
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      lastError: { code: 'unauthenticated' },
    })
    await h.waitFor(() => fake.gateway.connections.size === 0)
    // The gate cleared the dead cookies with its 401 (middleware.py:150-157).
    expect(jar.jar.size).toBe(0)
  })

  it('goes signed out when another tab signed this browser out', async () => {
    const { fake, jar, h } = await signedIn()
    // Tabs share the cookies, so the gate now sees none: 401 unauthenticated.
    await jar.fetch(`${fake.origin}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
    })
    expect((await failure(h.client.call('memory.overview', {})))?.code).toBe(
      'unauthenticated',
    )
    expect(h.store.getState().link.phase).toBe('signed-out')
  })

  it('signs back in after the login page once Hermes ended the session', async () => {
    const { fake, jar, h } = await signedIn()
    const probes = () => requests(fake, 'GET /api/learning/graph')
    await h.waitFor(() => probes() === 1)
    fake.auth.revokeAll()
    await failure(h.client.call('memory.overview', {}))
    // Until the login page, signing in again says where to go, on the link too.
    const early = await failure(h.client.call('auth.signIn', { origin: fake.origin }))
    expect(early?.message).toMatch(/Sign in on the Hermes login page/)
    expect(h.store.getState().link.lastError?.message).toMatch(
      /Sign in on the Hermes login page/,
    )
    await passwordLogin(fake, jar)
    await h.client.call('auth.signIn', { origin: fake.origin })
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    // The new session's routes are probed afresh.
    await h.waitFor(() => probes() === 2)
  })

  it('goes signed out when the background memory probe finds the session over', async () => {
    const { fake, jar, h } = await cookieClient()
    const probe = fake.holdNextRest('GET /api/learning/graph')
    await passwordLogin(fake, jar)
    await h.client.call('auth.signIn', { origin: fake.origin })
    await probe.arrived
    fake.auth.revokeAll()
    probe.release()
    await h.waitFor(() => h.store.getState().link.phase === 'signed-out')
    expect(h.store.getState().link.lastError?.code).toBe('unauthenticated')
  })

  it('keeps the session through a 401 that is not the gate ending it', async () => {
    const { fake, h } = await signedIn()
    // A 401 without the gate's `unauthenticated`/`session_expired` (a proxy, say).
    fake.failNextRest('GET /api/memory', 401)
    expect((await failure(h.client.call('memory.overview', {})))?.code).toBe(
      'unauthenticated',
    )
    expect(h.store.getState().link.phase).toBe('online')
    await h.client.call('memory.overview', {})
  })

  it('keeps the session through a refusal that is not a 401, whatever it says', async () => {
    const { fake, h } = await signedIn()
    const held = fake.holdNextRest('GET /api/memory')
    const call = failure(h.client.call('memory.overview', {}))
    await held.arrived
    held.release({ status: 403, body: SESSION_EXPIRED })
    expect((await call)?.code).toBe('forbidden')
    expect(h.store.getState().link.phase).toBe('online')
  })

  it('keeps a sign-out clean when a call made before it then meets the gate', async () => {
    const { fake, h } = await signedIn()
    const held = fake.holdNextRest('GET /api/memory')
    const call = failure(h.client.call('memory.overview', {}))
    await held.arrived
    await h.client.call('auth.signOut', {})
    held.release({ status: 401, body: SESSION_EXPIRED })
    expect((await call)?.code).toBe('unauthenticated')
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(h.store.getState().link.lastError).toBeUndefined()
  })

  it('shows the agent screen: display.observe over the socket, frames over the display socket', async () => {
    const { fake, h } = await signedIn({ screen: true })
    await h.waitFor(
      () => h.store.getState().capabilities['computer.view']?.state === 'available',
    )
    const { viewId } = await h.client.call('display.watch', {})
    const frame = await h.client.call('display.frame', { viewId })
    expect(frame.regions.length).toBeGreaterThan(0)
    expect(h.rpcCalls('display.observe')).toBe(1)
    expect(requests(fake, '/api/display/ws')).toBe(1)
    await h.client.call('display.unwatch', { viewId })
  })
})

describe('direct client in native mode, unchanged', () => {
  it('signs out without calling /auth/logout', async () => {
    const h = await harness()
    // Nothing to confirm: a native sign-out never asks Hermes.
    expect(await h.client.call('auth.signOut', {})).toStrictEqual({ localOnly: true })
    expect(requests(h.fake, 'POST /auth/logout')).toBe(0)
  })

  it('stays signed in through a gate 401 that follows a refresh', async () => {
    const h = await harness()
    const first = h.fake.holdNextRest('GET /api/memory')
    const call = failure(h.client.call('memory.overview', {}))
    await first.arrived
    const retry = h.fake.holdNextRest('GET /api/memory')
    first.release({ status: 401, body: SESSION_EXPIRED })
    await retry.arrived
    retry.release({ status: 401, body: SESSION_EXPIRED })
    expect((await call)?.code).toBe('unauthenticated')
    expect(requests(h.fake, 'POST /auth/native/refresh')).toBe(1)
    expect(h.store.getState().link.phase).toBe('online')
  })
})

describe('direct client in cookie mode: a sign-out in another tab', () => {
  it("ends this tab's session at its next request tick", async () => {
    const { fake, a, b } = await twoTabs({ connection: { requestSyncMs: 30 } })
    await a.client.call('auth.signOut', {})
    // Hermes checked b's socket only when it opened (chat_ws.py:137-171).
    await b.waitFor(() => b.store.getState().link.phase === 'signed-out')
    expect(b.store.getState().link.lastError?.code).toBe('unauthenticated')
    await b.waitFor(() => fake.gateway.connections.size === 0)
    const refused = await failure(
      b.client.call('conversations.create', { title: 'After sign-out (fixture)' }),
    )
    expect(refused?.message).toMatch(/Sign in/)
  })

  it('ends it at once on the platform cue, as a page coming back into view', async () => {
    const page = pageCue()
    // No tick (requestSyncMs 0): only the cue can tell b.
    const { fake, a, b } = await twoTabs(
      { connection: { requestSyncMs: 0 } },
      { watchSession: page.watchSession },
    )
    expect(page.listening).toBe(1)
    await a.client.call('auth.signOut', {})
    await pause(40)
    expect(b.store.getState().link.phase).toBe('online')
    const checks = requests(fake, 'GET /api/auth/me')
    page.fire()
    page.fire()
    page.fire()
    await b.waitFor(() => b.store.getState().link.phase === 'signed-out')
    // Three cues, one check; and a client that stopped no longer listens.
    expect(requests(fake, 'GET /api/auth/me')).toBe(checks + 1)
    expect(page.listening).toBe(0)
  })

  it('keeps the session when the check finds it, or Hermes does not answer it', async () => {
    const page = pageCue()
    const { fake, b } = await twoTabs(
      { connection: { requestSyncMs: 0 } },
      { watchSession: page.watchSession },
    )
    const checks = requests(fake, 'GET /api/auth/me')
    page.fire()
    await b.waitFor(() => requests(fake, 'GET /api/auth/me') === checks + 1)
    fake.failNextRest('GET /api/auth/me', 503)
    page.fire()
    await b.waitFor(() => requests(fake, 'GET /api/auth/me') === checks + 2)
    await pause(20)
    expect(b.store.getState().link.phase).toBe('online')
  })

  it('checks once more for a cue that comes while a check is out, as when another tab signs out', async () => {
    const page = pageCue()
    const { fake, a, b } = await twoTabs(
      { connection: { requestSyncMs: 0 } },
      { watchSession: page.watchSession },
    )
    // b's check goes out while the cookies still work, and Hermes holds it.
    const held = fake.holdNextRest('GET /api/auth/me')
    page.fire()
    await held.arrived
    // a signs out meanwhile, and its announcement reaches b with the check still out.
    await a.client.call('auth.signOut', {})
    page.fire()
    const checks = requests(fake, 'GET /api/auth/me')
    held.release()
    // The held check answers for the session as it was; the one after it finds it gone.
    await b.waitFor(() => b.store.getState().link.phase === 'signed-out')
    expect(requests(fake, 'GET /api/auth/me')).toBe(checks + 1)
  })

  it('lets no answer about an ended session end the next one', async () => {
    const page = pageCue()
    const { fake, jar, a, b } = await twoTabs(
      { connection: { requestSyncMs: 0 } },
      { watchSession: page.watchSession },
    )
    await a.client.call('auth.signOut', {})
    // b's check goes out without cookies, and Hermes holds it.
    const held = fake.holdNextRest('GET /api/auth/me')
    page.fire()
    await held.arrived
    // b's session ends another way meanwhile (its reconnect is refused), and b signs in again.
    fake.gateway.dropConnections()
    await b.waitFor(() => b.store.getState().link.phase === 'signed-out')
    await passwordLogin(fake, jar)
    await b.client.call('auth.signIn', { origin: fake.origin })
    await b.waitFor(() => b.store.getState().link.phase === 'online')
    // A cue now gets a check of its own, not the old one still out.
    const checks = requests(fake, 'GET /api/auth/me')
    page.fire()
    await b.waitFor(() => requests(fake, 'GET /api/auth/me') === checks + 1)
    // The old check's 401 comes back only now: it says nothing about this session.
    held.release()
    await pause(40)
    expect(b.store.getState().link.phase).toBe('online')
  })

  it('lets no 401 to an operation sent under an ended session end the next one', async () => {
    const { fake, jar, a, b } = await twoTabs({ connection: { requestSyncMs: 0 } })
    await a.client.call('auth.signOut', {})
    // b asks for memory without cookies, and Hermes holds the request.
    const held = fake.holdNextRest('GET /api/memory')
    const call = failure(b.client.call('memory.overview', {}))
    await held.arrived
    // b's session ends another way (its reconnect is refused), and b signs in again.
    fake.gateway.dropConnections()
    await b.waitFor(() => b.store.getState().link.phase === 'signed-out')
    await passwordLogin(fake, jar)
    await b.client.call('auth.signIn', { origin: fake.origin })
    await b.waitFor(() => b.store.getState().link.phase === 'online')
    // The old request's 401 comes back only now: it fails its call, nothing more.
    held.release()
    expect((await call)?.code).toBe('unauthenticated')
    await pause(40)
    expect(b.store.getState().link.phase).toBe('online')
  })

  it('lets no 401 to a memory probe sent under an ended session end the next one', async () => {
    let probe: ReturnType<FakeHermes['holdNextRest']> | undefined
    const { fake, jar, a, b } = await twoTabs(
      { connection: { requestSyncMs: 0 } },
      {},
      async (f) => {
        // a's own probe has gone out; hold the one b sends when it connects.
        await waitUntil(() => requests(f, 'GET /api/learning/graph') === 1)
        probe = f.holdNextRest('GET /api/learning/graph')
      },
    )
    await probe?.arrived
    await a.client.call('auth.signOut', {})
    fake.gateway.dropConnections()
    await b.waitFor(() => b.store.getState().link.phase === 'signed-out')
    await passwordLogin(fake, jar)
    await b.client.call('auth.signIn', { origin: fake.origin })
    await b.waitFor(() => b.store.getState().link.phase === 'online')
    // The probe from b's first session gets the gate's 401 only now.
    probe?.release({ status: 401, body: SESSION_EXPIRED })
    await pause(40)
    expect(b.store.getState().link.phase).toBe('online')
  })
})

describe('direct client in native mode: no cookie session to check', () => {
  it('neither listens for the cue nor asks GET /api/auth/me on its tick', async () => {
    const page = pageCue()
    const h = await harness({
      deps: { watchSession: page.watchSession, connection: { requestSyncMs: 20 } },
    })
    const checks = requests(h.fake, 'GET /api/auth/me')
    await pause(120)
    expect(page.listening).toBe(0)
    expect(requests(h.fake, 'GET /api/auth/me')).toBe(checks)
  })
})

describe('direct client in cookie mode: open request cards when the session ends', () => {
  it('closes them when Hermes ends the session, and shows them again after sign-in', async () => {
    const { fake, jar, h } = await signedIn()
    const request = await openApproval(h, fake)
    fake.auth.revokeAll()
    await failure(h.client.call('memory.overview', {}))
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(requestStatus(h, request.requestId)).toBe('cancelled')
    // Hermes still holds it, so after a new sign-in the card is back.
    await passwordLogin(fake, jar)
    await h.client.call('auth.signIn', { origin: fake.origin })
    await h.waitFor(() => requestStatus(h, request.requestId) === 'open')
  })

  it('closes them when a reconnect finds the session gone', async () => {
    // No tick, so only the reconnect's ws-ticket can tell b.
    const { fake, a, b } = await twoTabs({ connection: { requestSyncMs: 0 } })
    const request = await openApproval(b, fake)
    await a.client.call('auth.signOut', {})
    fake.gateway.dropConnections()
    await b.waitFor(() => b.store.getState().link.phase === 'signed-out')
    expect(requestStatus(b, request.requestId)).toBe('cancelled')
  })
})

describe('direct client in cookie mode: confirming a sign-out', () => {
  const notices = (h: Harness) =>
    h.events.filter((e) => e.type === 'notice' && /did not confirm/.test(e.message))
      .length

  it('posts /auth/logout again on a second sign-out after Hermes did not confirm', async () => {
    const { fake, jar, h } = await signedIn()
    fake.failNextRest('POST /auth/logout', 500)
    await h.client.call('auth.signOut', {})
    expect(jar.jar.size).toBe(3)
    expect(notices(h)).toBe(1)
    // Signed out here already, the second sign-out still asks Hermes.
    expect(await h.client.call('auth.signOut', {})).toStrictEqual({
      localOnly: true,
      hermesConfirmed: true,
    })
    expect(requests(fake, 'POST /auth/logout')).toBe(2)
    expect(jar.jar.size).toBe(0)
    expect(notices(h)).toBe(1)
  })

  it("does not take a 401 that is not the gate's for a confirmation", async () => {
    const { fake, h } = await signedIn()
    // Hermes clears the cookies, but a proxy answers the check with its own 401.
    fake.failNextRest('GET /api/auth/me', 401)
    expect(await h.client.call('auth.signOut', {})).toMatchObject({
      hermesConfirmed: false,
    })
    expect(notices(h)).toBe(1)
  })

  it('does not take a redirect that never reached Hermes for a sign-out', async () => {
    const { fake, jar, h } = await signedIn()
    // A proxy in front of Hermes answers the redirect; Hermes clears nothing.
    const held = fake.holdNextRest('POST /auth/logout')
    const signingOut = h.client.call('auth.signOut', {})
    await held.arrived
    held.release({ status: 302, body: {} })
    expect(await signingOut).toStrictEqual({ localOnly: true, hermesConfirmed: false })
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(jar.jar.size).toBe(3)
    expect(notices(h)).toBe(1)
  })
})

/** A cookie-mode client like the harness's, which the test starts itself. */
function manualClient(fake: FakeHermes, jar: Jar) {
  const client = createDirectClient({
    origin: fake.origin,
    auth: 'same-origin-cookie',
    fetch: jar.fetch,
    socketFactory: nodeSocketFactory(),
    clock: systemClock,
    kv: memoryKv(),
    random: () => 0.5,
    connection: { backoff: { initialMs: 20, maxMs: 100 } },
  })
  const store = createStore({
    phase: 'unconfigured',
    since: '2026-01-01T00:00:00.000Z',
    connectionEpoch: 0,
  })
  client.subscribe((event) => store.dispatch(event))
  onTestFinished(() => client.stop())
  return { client, store }
}

describe('direct client: discovery that stop() or a newer run overtakes', () => {
  it('stays stopped when stop() comes while Hermes answers', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    await passwordLogin(fake, jar)
    const held = fake.holdNextRest('GET /api/auth/me')
    const { client, store } = manualClient(fake, jar)
    const starting = client.start()
    await held.arrived
    client.stop()
    held.release()
    await starting
    await pause(50)
    expect(requests(fake, '/api/ws')).toBe(0)
    expect(store.getState().link.phase).toBe('offline')
  })

  it('asks nothing more when stop() comes while Hermes reads its status', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    await passwordLogin(fake, jar)
    const held = fake.holdNextRest('GET /api/status')
    const { client, store } = manualClient(fake, jar)
    const starting = client.start()
    await held.arrived
    client.stop()
    held.release()
    await starting
    await pause(50)
    expect(requests(fake, 'GET /api/auth/me')).toBe(0)
    expect(store.getState().link.phase).toBe('offline')
  })

  it('leaves the connecting to a newer start', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    await passwordLogin(fake, jar)
    const held = fake.holdNextRest('GET /api/auth/me')
    const { client, store } = manualClient(fake, jar)
    const first = client.start()
    await held.arrived
    client.stop()
    await client.start()
    await waitUntil(() => store.getState().link.phase === 'online')
    held.release()
    await first
    await pause(50)
    expect(requests(fake, '/api/ws')).toBe(1)
  })

  it('leaves the link to a sign-in that overtakes a discovery still asking', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    // The discovery asks before the browser has signed in: its answer is a 401.
    const held = fake.holdNextRest('GET /api/auth/me')
    const { client, store } = manualClient(fake, jar)
    const starting = client.start()
    await held.arrived
    await passwordLogin(fake, jar)
    await client.call('auth.signIn', { origin: fake.origin })
    await waitUntil(() => store.getState().link.phase === 'online')
    held.release()
    await starting
    await pause(50)
    expect(store.getState().link.phase).toBe('online')
    expect(requests(fake, '/api/ws')).toBe(1)
  })

  it('keeps a sign-in that stop() overtook from connecting, until start()', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    const { client, store } = manualClient(fake, jar)
    await client.start()
    expect(store.getState().link.phase).toBe('signed-out')
    await passwordLogin(fake, jar)
    const held = fake.holdNextRest('GET /api/auth/me')
    const signingIn = client.call('auth.signIn', { origin: fake.origin })
    await held.arrived
    client.stop()
    held.release()
    await signingIn
    await pause(50)
    expect(requests(fake, '/api/ws')).toBe(0)
    expect(store.getState().link.phase).not.toBe('online')
    await client.start()
    await waitUntil(() => store.getState().link.phase === 'online')
  })
})

describe('direct client: discovery when Hermes does not answer', () => {
  const linkErrors = (h: Harness) =>
    h.events.flatMap((e) =>
      e.type === 'link.changed' && e.link.lastError
        ? [`${e.link.phase} ${e.link.lastError.code}`]
        : [],
    )

  it('shows a 5xx on its own sign-in check as offline and asks again', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    await passwordLogin(fake, jar)
    fake.failNextRest('GET /api/auth/me', 503)
    const h = await harness({
      fake,
      signIn: false,
      deps: { auth: 'same-origin-cookie', fetch: jar.fetch },
    })
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    expect(linkErrors(h)).toContain('offline unavailable')
    expect(requests(fake, 'GET /api/auth/me')).toBe(2)
  })

  it('keeps the link offline, not connecting, between attempts', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    await passwordLogin(fake, jar)
    let failures = 2
    const restarting: FetchLike = (url, init) =>
      new URL(url).pathname === '/api/auth/me' && failures-- > 0
        ? Promise.resolve(
            new Response('{"detail":"Service Unavailable"}', { status: 503 }),
          )
        : jar.fetch(url, init)
    const h = await harness({
      fake,
      signIn: false,
      deps: { auth: 'same-origin-cookie', fetch: restarting },
    })
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    // Two failed attempts, one offline link: the retry did not flip it back.
    const phases = h.events.flatMap((e) =>
      e.type === 'link.changed' ? [e.link.phase] : [],
    )
    expect(phases).toEqual(['connecting', 'offline', 'connecting', 'online'])
  })

  it('asks again after no answer at all', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    await passwordLogin(fake, jar)
    let dropped = false
    const flaky: FetchLike = (url, init) => {
      if (!dropped && new URL(url).pathname === '/api/status') {
        dropped = true
        return Promise.reject(new TypeError('network error (fixture)'))
      }
      return jar.fetch(url, init)
    }
    const h = await harness({
      fake,
      signIn: false,
      deps: { auth: 'same-origin-cookie', fetch: flaky },
    })
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    expect(linkErrors(h)).toContain('offline offline')
  })

  it('shows an answer that is not Hermes as an error, without asking again', async () => {
    const fake = await fakeHermes()
    fake.failNextRest('GET /api/status', 404)
    const h = await harness({ fake, signIn: false })
    expect(h.store.getState().link).toMatchObject({
      phase: 'error',
      lastError: { code: 'not-found' },
    })
    await pause(150)
    expect(requests(fake, 'GET /api/status')).toBe(1)
  })

  it('stops asking once stopped', async () => {
    const fake = await fakeHermes()
    const jar = cookieJar(fake.origin)
    await passwordLogin(fake, jar)
    fake.failNextRest('GET /api/auth/me', 503)
    const h = await harness({
      fake,
      signIn: false,
      deps: {
        auth: 'same-origin-cookie',
        fetch: jar.fetch,
        connection: { backoff: { initialMs: 60, maxMs: 100 } },
      },
    })
    expect(h.store.getState().link.phase).toBe('offline')
    h.client.stop()
    await pause(200)
    expect(requests(fake, 'GET /api/auth/me')).toBe(1)
  })
})
