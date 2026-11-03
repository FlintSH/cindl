import { afterEach, describe, expect, it } from 'vitest'
import {
  closeFakes,
  FIXTURE_LOGIN,
  startFakeHermes,
  type FakeHermes,
} from '../src/fake-hermes/index.ts'

const fakes: FakeHermes[] = []
afterEach(() => closeFakes(fakes.splice(0)))
async function fake(options: Parameters<typeof startFakeHermes>[0] = {}) {
  const started = await startFakeHermes(options)
  fakes.push(started)
  return started
}

/** The `next` the login page puts in its form, as the page's script reads it. */
async function formNext(f: FakeHermes, query: string): Promise<string> {
  const page = await fetch(`${f.origin}/login${query}`)
  expect(page.headers.get('content-type')).toMatch(/^text\/html/)
  expect(page.headers.get('cache-control')).toBe('no-store')
  const value = /name="next" value="([^"]*)"/.exec(await page.text())?.[1] ?? ''
  return value.replace(/&#(\d+);/g, (_, code: string) =>
    String.fromCharCode(Number(code)),
  )
}

function login(f: FakeHermes, body: Record<string, unknown>) {
  return fetch(`${f.origin}/auth/password-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'basic', ...FIXTURE_LOGIN, ...body }),
  })
}

/** `name=value` of every cookie a response sets, deletions as `name=`. */
const setCookies = (response: Response) =>
  response.headers.getSetCookie().map((line) => line.split(';')[0] ?? '')

const cookieHeader = (response: Response) => setCookies(response).join('; ')

/** cookies.py:109-128: the deletions for every variant of these names. */
const variantsOf = (...names: string[]) =>
  names.flatMap((name) => [`__Host-${name}=`, `__Secure-${name}=`, `${name}=`])

const SESSION_NAMES = [
  'hermes_session_at',
  'hermes_session_rt',
  'hermes_session_provider',
]

/** Every line deletes (Max-Age=0), and every prefixed one is Secure, as browsers require. */
function deletesOnly(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .every(
      (line) =>
        /Max-Age=0/.test(line) &&
        (!/^__(Host|Secure)-/.test(line) || /Secure/.test(line)),
    )
}

describe('fake Hermes: the login page (routes.py:195-200)', () => {
  it('threads a safe next into its form, decoded once more, and drops the rest', async () => {
    const f = await fake()
    expect(await formNext(f, '?next=%2Fcindl%2F')).toBe('/cindl/')
    // request_utils.py `_validate_post_login_target` unquotes the query value again.
    expect(await formNext(f, '?next=%252Fcindl%252520x')).toBe('/cindl%20x')
    for (const next of [
      '%2F%2Felsewhere.invalid',
      '%2Fapi%2Fstatus',
      '%2Flogin',
      'cindl',
    ])
      expect(await formNext(f, `?next=${next}`), next).toBe('')
    expect(await formNext(f, '')).toBe('')
  })
})

describe('fake Hermes: password login (routes.py:447-494)', () => {
  it('signs in with the fixture password, setting the three session cookies', async () => {
    const f = await fake()
    const response = await login(f, { next: '/cindl/%2520' })
    expect(await response.json()).toEqual({ ok: true, next: '/cindl/%20' })
    expect(setCookies(response).map((c) => c.split('=')[0])).toEqual([
      'hermes_session_at',
      'hermes_session_rt',
      'hermes_session_provider',
    ])
    const me = await fetch(`${f.origin}/api/auth/me`, {
      headers: { Cookie: cookieHeader(response) },
    })
    expect(me.status).toBe(200)
  })

  it('lands on / for an unsafe next', async () => {
    const f = await fake()
    expect(await (await login(f, { next: '//elsewhere.invalid/' })).json()).toEqual({
      ok: true,
      next: '/',
    })
  })

  it('answers generically: 404 for a provider without a password, 401 for a wrong one', async () => {
    const f = await fake({
      providers: [
        { name: 'basic', supportsPassword: true },
        { name: 'portal', displayName: 'Portal (fixture)' },
      ],
    })
    for (const provider of ['portal', 'nobody']) {
      const refused = await login(f, { provider })
      expect(refused.status, provider).toBe(404)
      expect(setCookies(refused)).toEqual([])
    }
    const wrong = await login(f, { password: 'not-the-fixture-password' })
    expect(wrong.status).toBe(401)
    expect(setCookies(wrong)).toEqual([])
  })
})

describe('fake Hermes: sign-out (routes.py:496-512)', () => {
  it('clears the cookies and redirects to /login, but revokes nothing', async () => {
    const f = await fake()
    const session = cookieHeader(await login(f, {}))
    const logout = await fetch(`${f.origin}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: session },
      redirect: 'manual',
    })
    expect(logout.status).toBe(302)
    expect(logout.headers.get('location')).toBe('/login')
    // The session cookies and the PKCE cookie, every name variant (routes.py:510-511).
    expect(setCookies(logout)).toEqual(
      variantsOf(...SESSION_NAMES, 'hermes_session_pkce'),
    )
    expect(deletesOnly(logout)).toBe(true)
    // The password provider's tokens are stateless (basic/__init__.py:165-167):
    // a copy of the cookies still works until it expires.
    const copied = await fetch(`${f.origin}/api/auth/me`, {
      headers: { Cookie: session },
    })
    expect(copied.status).toBe(200)
  })
})

describe('fake Hermes: the cookie gate (middleware.py:150-219)', () => {
  it('answers 401 unauthenticated without cookies, and leaves none set', async () => {
    const f = await fake()
    const response = await fetch(`${f.origin}/api/auth/me`)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: 'unauthenticated',
      reason: 'no_cookie',
    })
    expect(setCookies(response)).toEqual([])
  })

  it('rotates once for a burst carrying the same stale cookies, for 30 s', async () => {
    const f = await fake()
    const session = cookieHeader(await login(f, {}))
    f.auth.expireAccessTokens()
    const me = () => fetch(`${f.origin}/api/auth/me`, { headers: { Cookie: session } })
    const [first, second] = await Promise.all([me(), me()])
    expect([first.status, second.status]).toEqual([200, 200])
    expect(setCookies(first)).toHaveLength(3)
    expect(setCookies(second)).toEqual(setCookies(first))
    // refresh_singleflight.py:24-28: the replay lasts 30 s. The password
    // provider's tokens are stateless, so then the same refresh token rotates
    // again, into a new session.
    f.advance(31_000)
    const later = await me()
    expect(later.status).toBe(200)
    expect(setCookies(later)).toHaveLength(3)
    expect(setCookies(later)).not.toEqual(setCookies(first))
  })

  it('keeps an access token working after it rotated, as stateless tokens do', async () => {
    const f = await fake()
    const session = f.signIn()
    const refreshed = await fetch(`${f.origin}/auth/native/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    })
    expect(refreshed.status).toBe(200)
    // basic/__init__.py:151-163: nothing is spent, so the old pair still verifies.
    const me = await fetch(`${f.origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
    expect(me.status).toBe(200)
  })

  it('forgets those replays when every session is revoked', async () => {
    const f = await fake()
    const session = cookieHeader(await login(f, {}))
    f.auth.expireAccessTokens()
    const me = () => fetch(`${f.origin}/api/auth/me`, { headers: { Cookie: session } })
    expect((await me()).status).toBe(200)
    f.auth.revokeAll()
    expect((await me()).status).toBe(401)
  })

  it('answers 401 session_expired and clears the cookies when the refresh fails', async () => {
    const f = await fake()
    const session = cookieHeader(await login(f, {}))
    f.auth.revokeAll()
    const response = await fetch(`${f.origin}/api/auth/me`, {
      headers: { Cookie: session },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'session_expired' })
    expect(setCookies(response)).toEqual(variantsOf(...SESSION_NAMES))
    expect(deletesOnly(response)).toBe(true)
  })
})

describe('fake Hermes: OAuth sign-in (routes.py:217-233, 338-379)', () => {
  const PROVIDERS = [
    { name: 'basic', supportsPassword: true },
    { name: 'portal', displayName: 'Portal (fixture)' },
  ]

  /** One hop, by hand: the Set-Cookie lines Hermes answered, and where it sent the browser. */
  async function hop(f: FakeHermes, path: string, cookie = '') {
    const response = await fetch(`${f.origin}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: 'manual',
    })
    return {
      status: response.status,
      location: response.headers.get('location') ?? '',
      cookie: cookieHeader(response),
      set: setCookies(response),
    }
  }

  it('links an OAuth provider from the login page, carrying next', async () => {
    const f = await fake({ providers: PROVIDERS })
    const page = await (await fetch(`${f.origin}/login?next=%2Fcindl%2F`)).text()
    expect(page).toContain(
      'href="/auth/login?provider=portal&#38;next=%2Fcindl%2F">Sign in with Portal (fixture)',
    )
  })

  it('signs in through /auth/login, the IdP stand-in and /auth/callback', async () => {
    const f = await fake({ providers: PROVIDERS })
    const start = await hop(f, '/auth/login?provider=portal&next=%2Fcindl%2F')
    expect(start.status).toBe(302)
    expect(start.location).toMatch(/^\/auth\/callback\?code=fixture-oauth-code&state=/)
    expect(start.set).toHaveLength(1)
    const back = await hop(f, start.location, start.cookie)
    expect(back.status).toBe(302)
    expect(back.location).toBe('/cindl/')
    // The session cookies, then every variant of the spent PKCE cookie deleted.
    expect(back.set.slice(0, 3).map((c) => c.split('=')[0])).toEqual(SESSION_NAMES)
    expect(back.set.slice(3)).toEqual(variantsOf('hermes_session_pkce'))
    const session = back.set.slice(0, 3).join('; ')
    expect(
      (await fetch(`${f.origin}/api/auth/me`, { headers: { Cookie: session } })).status,
    ).toBe(200)
  })

  it('refuses a callback without its PKCE cookie, or with another state', async () => {
    const f = await fake({ providers: PROVIDERS })
    const start = await hop(f, '/auth/login?provider=portal')
    expect((await hop(f, start.location)).status).toBe(400)
    const forged = start.location.replace(/state=[^&]*/, 'state=forged')
    expect((await hop(f, forged, start.cookie)).status).toBe(400)
  })

  it("sends a password provider's /auth/login to the login page, next kept", async () => {
    const f = await fake({ providers: PROVIDERS })
    const start = await hop(f, '/auth/login?provider=basic&next=%2Fcindl%2F')
    expect([start.status, start.location]).toEqual([302, '/login?next=%2Fcindl%2F'])
    expect((await hop(f, '/auth/login?provider=nobody')).status).toBe(404)
  })
})
