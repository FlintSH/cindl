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
    expect(setCookies(logout)).toEqual([
      'hermes_session_at=',
      'hermes_session_rt=',
      'hermes_session_provider=',
    ])
    expect(logout.headers.getSetCookie().every((line) => /Max-Age=0/.test(line))).toBe(
      true,
    )
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
    // refresh_singleflight.py:24-28: the replay lasts 30 s; then the rotated
    // refresh token is spent.
    f.advance(31_000)
    expect((await me()).status).toBe(401)
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
    expect(setCookies(response)).toEqual([
      'hermes_session_at=',
      'hermes_session_rt=',
      'hermes_session_provider=',
    ])
  })
})
