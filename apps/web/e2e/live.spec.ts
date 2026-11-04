import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startFakeHermes, type FakeHermes } from '@cindl/fixtures/fake-hermes'
import { expect, test, type Page } from '@playwright/test'
import { startSameOrigin, type SameOrigin } from './live/sameOrigin.ts'

/**
 * The REAL production web build (`dist`, no demo data) served at `/cindl/` on
 * the same origin as a FAKE Hermes (test-only, synthetic, loopback). This is
 * the browser's live path end to end against the fake: Hermes's cookie
 * sign-in, the gateway socket with its ticket, chat, an approval answered
 * once, a reconnect. It is not proof against a real Hermes; that is checked
 * where the real one runs.
 */
const web = fileURLToPath(new URL('..', import.meta.url))
const dist = fileURLToPath(new URL('../dist/', import.meta.url))

let fake: FakeHermes
let site: SameOrigin

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // The same files a deployment serves. CI and local runs build them here;
  // CINDL_E2E_LIVE_BUILT=1 reuses a build that is already current.
  test.setTimeout(240_000)
  if (process.env.CINDL_E2E_LIVE_BUILT !== '1')
    execFileSync('pnpm', ['run', 'build'], { cwd: web, stdio: 'inherit' })
  fake = await startFakeHermes()
  site = await startSameOrigin({ dist: dist.replace(/\/$/, ''), hermesPort: fake.port })
})

test.afterAll(async () => {
  await site.close()
  await fake.close()
  expect(fake.violations).toEqual([])
})

/** One pixel of the agent's screen, in screen coordinates. */
const pixel = (page: Page, x: number, y: number) =>
  page
    .getByRole('img', { name: /agent’s screen, live/ })
    .or(page.getByRole('application', { name: /agent’s screen, live/ }))
    .evaluate(
      (canvas: HTMLCanvasElement, [px, py]: number[]) => [
        ...canvas.getContext('2d')!.getImageData(px!, py!, 1, 1).data,
      ],
      [x, y],
    )

test("served at /cindl/ on Hermes's origin, the production build signs in with Hermes's cookie and talks to Hermes", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const offOrigin: string[] = []
  const sockets: string[] = []
  const errors: string[] = []
  const elsewhere = (url: string) =>
    /^(https?|wss?):/.test(url) && new URL(url).host !== new URL(site.origin).host
  page.on('request', (request) => {
    if (elsewhere(request.url())) offOrigin.push(request.url())
  })
  page.on('websocket', (socket) => sockets.push(socket.url()))
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(`${message.text()} (${message.location().url || 'page'})`)
  })
  page.on('pageerror', (error) => errors.push(String(error)))

  // Not signed in: Cindl offers Hermes's own sign-in, and asks for nothing itself.
  await page.goto(`${site.origin}/cindl/`)
  const signIn = page.getByRole('button', { name: 'Sign in on Hermes' })
  await expect(signIn).toBeVisible()
  await expect(page.getByLabel('Hermes address')).toHaveCount(0)
  // The one expected error: Hermes refusing /api/auth/me without a session.
  expect(errors).toEqual([
    `Failed to load resource: the server responded with a status of 401 (Unauthorized) (${site.origin}/api/auth/me)`,
  ])
  errors.length = 0

  // Hermes's own login page (the fake's stand-in, prefilled with the synthetic
  // login), and back to where the owner was.
  await signIn.click()
  await page.waitForURL(/\/login\?next=/)
  expect(new URL(page.url()).searchParams.get('next')).toBe('/cindl/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(`${site.origin}/cindl/`)
  // Signed in: the conversation view, not the sign-in screen.
  await expect(page.getByRole('button', { name: 'Start a conversation' })).toBeVisible()
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'hermes_session_at',
  )
  // HttpOnly: the page itself can never read the session.
  expect(session?.httpOnly).toBe(true)

  // Chat: a new conversation, a message, Hermes's streamed reply.
  await page.getByRole('button', { name: 'Start a conversation' }).click()
  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await box.fill('Plan the studio offsite (fixture)')
  await box.press('Enter')
  await expect(
    page.getByText('Synthetic reply (fixture) to: Plan the studio offsite (fixture)'),
  ).toBeVisible()

  // An approval, answered once.
  const outcome: { result?: unknown } = {}
  fake.gateway.script = async (turn) => {
    outcome.result = await turn.approval({
      choices: ['once', 'session', 'always', 'deny'],
    })
  }
  await box.fill('Export the inventory (fixture)')
  await box.press('Enter')
  const allow = page.getByRole('button', { name: 'Allow once' }).first()
  await expect(allow).toBeVisible()
  // The right inspector: the conversation's working margin, a column at this
  // width, counts what the conversation waits on, and clears once answered.
  const margin = page.getByRole('complementary', { name: 'Working margin' })
  await expect(margin.getByRole('tab', { name: 'Waiting 1' })).toBeVisible()
  await allow.click()
  await expect.poll(() => outcome.result).toEqual({ choice: 'once' })
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0)
  await expect(margin.getByRole('tab', { name: 'Waiting', exact: true })).toBeVisible()

  // A dropped network: Cindl reconnects with a fresh ticket and carries on.
  const tickets = () =>
    fake.calls.filter((call) => call.name === 'POST /api/auth/ws-ticket').length
  const before = tickets()
  fake.gateway.script = async (turn) => {
    await turn.reply(`Synthetic reply (fixture) to: ${turn.text.slice(0, 40)}`)
  }
  fake.gateway.dropConnections()
  await expect.poll(tickets, { timeout: 20_000 }).toBeGreaterThan(before)
  await box.fill('Still there? (fixture)')
  await box.press('Enter')
  await expect(
    page.getByText('Synthetic reply (fixture) to: Still there? (fixture)'),
  ).toBeVisible()

  // A reload into a deep link keeps the session (the cookie) and nothing else.
  // The agent's screen comes over Hermes's display socket, with its own ticket,
  // and pointer input reaches it only after taking control.
  await page.goto(`${site.origin}/cindl/#/work`)
  const watching = page.getByRole('img', { name: 'The agent’s screen, live.' })
  await expect(watching).toBeVisible()
  await expect.poll(() => pixel(page, 2, 2)).toEqual([31, 42, 48, 255])
  await page.getByRole('button', { name: 'Take control…' }).click()
  await page.getByRole('button', { name: 'Take control now' }).click()
  const controlled = page.getByRole('application', { name: /You are in control/ })
  const area = (await controlled.boundingBox())!
  await controlled.click({
    position: { x: (300 * area.width) / 640, y: (200 * area.height) / 400 },
  })
  await expect.poll(() => pixel(page, 300, 200)).toEqual([230, 120, 40, 255])

  // Sign-out goes through Hermes, which clears its cookie in this browser.
  await page.goto(`${site.origin}/cindl/#/agent/device`)
  await page.getByRole('button', { name: 'Sign out on this device' }).click()
  // Signed out, the shell shows Hermes's sign-in in place of the view.
  await expect(page.getByRole('button', { name: 'Sign in on Hermes' })).toBeVisible()
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.startsWith('hermes_session'),
    ),
  ).toEqual([])
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in on Hermes' })).toBeVisible()
  // Signed out again, the reload asks Hermes who is there, as at the start.
  const refused = `Failed to load resource: the server responded with a status of 401 (Unauthorized) (${site.origin}/api/auth/me)`
  // The fake's stand-in login page declares no icon, so the browser asks the
  // origin for /favicon.ico there and the fake answers 404 (Hermes has its own).
  const noIcon = `Failed to load resource: the server responded with a status of 404 (Not Found) (${site.origin}/favicon.ico)`
  expect(errors.filter((error) => error !== refused && error !== noIcon)).toEqual([])
  errors.length = 0

  // The browser's path only: the cookie, the ticket, the gateway; no native sign-in.
  const names = fake.calls.map((call) => call.name)
  expect(names).toEqual(
    expect.arrayContaining([
      'GET /api/status',
      'GET /login',
      'GET /api/auth/me',
      'POST /api/auth/ws-ticket',
      '/api/ws',
      'POST /auth/logout',
    ]),
  )
  expect(names.filter((name) => name.includes('/auth/native/'))).toEqual([])
  // Nothing leaves the origin: every socket is Hermes's gateway on this origin.
  expect(offOrigin).toEqual([])
  const wsOrigin = site.origin.replace(/^http/, 'ws')
  const paths = sockets.map((url) => {
    expect(new URL(url).origin).toBe(wsOrigin)
    return new URL(url).pathname
  })
  expect(paths.filter((path) => path === '/api/ws').length).toBeGreaterThanOrEqual(2)
  expect(paths.filter((path) => path !== '/api/ws')).toEqual(['/api/display/ws'])
  // Browser storage holds only the theme and margin preferences, never a token or ticket.
  /* eslint-disable no-restricted-globals -- reads storage only to prove nothing is kept there */
  const kept = await page.evaluate(async () => ({
    local: Object.keys(localStorage).filter((key) => key !== 'cindl.preferences.v1'),
    session: sessionStorage.length,
    databases: (await indexedDB.databases()).map((database) => database.name),
  }))
  /* eslint-enable no-restricted-globals */
  expect(kept).toEqual({ local: [], session: 0, databases: [] })
  expect(errors).toEqual([])
})

test('a sign-out in one tab reaches the other tabs at once, and one Hermes did not confirm can be tried again', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const context = await browser.newContext()
  try {
    const errors: string[] = []
    const watch = (page: Page, name: string) =>
      page.on('console', (message) => {
        if (message.type() === 'error')
          errors.push(`${name}: ${message.text()} (${message.location().url || 'page'})`)
      })
    // Online, whatever conversations the fake already holds from the test before.
    const online = (page: Page) => page.getByRole('img', { name: 'Connected' })
    const a = await context.newPage()
    watch(a, 'a')
    await a.goto(`${site.origin}/cindl/`)
    await a.getByRole('button', { name: 'Sign in on Hermes' }).click()
    await a.waitForURL(/\/login\?next=/)
    await a.getByRole('button', { name: 'Sign in' }).click()
    await a.waitForURL(`${site.origin}/cindl/`)
    await expect(online(a)).toBeVisible()

    // A second tab, on the same cookie. Its clock stops once it is online, so
    // no timer of its own (the 15 s request tick) can ask Hermes about the
    // session: only the other tab's cue can.
    const b = await context.newPage()
    watch(b, 'b')
    const checks: string[] = []
    b.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/me')
        checks.push(request.method())
    })
    await b.clock.install()
    await b.goto(`${site.origin}/cindl/`)
    await expect(online(b)).toBeVisible()
    await b.clock.pauseAt(Date.now() + 1000)
    const before = checks.length
    const session = async () =>
      (await context.cookies()).filter((cookie) =>
        cookie.name.startsWith('hermes_session'),
      ).length

    // Hermes fails the logout: this tab says so and offers another try. The
    // other tab asks Hermes at once and, its cookie still good, stays signed in.
    fake.failNextRest('POST /auth/logout', 500)
    await a.goto(`${site.origin}/cindl/#/agent/device`)
    await a.getByRole('button', { name: 'Sign out on this device' }).click()
    // Named "Signing out…" while its request is out.
    const again = a.getByRole('button', { name: /^(Sign out on Hermes|Signing out…)$/ })
    await expect(again).toBeVisible()
    await expect(a.getByText(/Hermes has not confirmed the sign-out/)).toBeVisible()
    await expect.poll(() => checks.length).toBe(before + 1)
    await expect(online(b)).toBeVisible()
    expect(await session()).toBeGreaterThan(0)

    // Tried again from the keyboard and still refused. While Hermes holds the
    // request the button is disabled, which takes focus off it; once the
    // refusal lands, focus is back on the offer.
    const signInHere = a.getByRole('button', { name: 'Sign in on Hermes' })
    let held = fake.holdNextRest('POST /auth/logout')
    await again.focus()
    await a.keyboard.press('Enter')
    await held.arrived
    await expect(again).toBeDisabled()
    await expect(again).not.toBeFocused()
    held.release({ status: 500, body: {} })
    await expect.poll(() => checks.length).toBe(before + 2)
    await expect(again).toBeEnabled()
    await expect(again).toBeFocused()

    // Once more, with the owner moving focus elsewhere while it is out: it stays there.
    held = fake.holdNextRest('POST /auth/logout')
    await a.keyboard.press('Enter')
    await held.arrived
    await signInHere.focus()
    held.release({ status: 500, body: {} })
    await expect.poll(() => checks.length).toBe(before + 3)
    await expect(again).toBeEnabled()
    await expect(signInHere).toBeFocused()

    // Hermes clears the cookie this time: this tab confirms it and moves focus
    // to signing in, and the other tab, told at once, signs out too.
    await again.focus()
    await a.keyboard.press('Enter')
    await expect(
      a
        .getByRole('status')
        .filter({ hasText: 'Hermes cleared its session cookie in this browser.' }),
    ).toBeVisible()
    await expect(again).toHaveCount(0)
    await expect(signInHere).toBeFocused()
    await expect(b.getByRole('button', { name: 'Sign in on Hermes' })).toBeVisible()
    expect(checks.length).toBe(before + 4)
    expect(await session()).toBe(0)

    // "Check again" with no session: Hermes says so, and focus is back on the button.
    const checkAgain = a.getByRole('button', { name: /^(Check again|Checking…)$/ })
    held = fake.holdNextRest('GET /api/auth/me')
    await checkAgain.focus()
    await a.keyboard.press('Enter')
    await held.arrived
    await expect(checkAgain).not.toBeFocused()
    held.release()
    await expect(a.getByRole('alert')).toHaveText(
      'Sign in on the Hermes login page, then try again.',
    )
    await expect(checkAgain).toBeFocused()

    // Expected errors only: Hermes's three failed logouts, the gate's 401
    // before the sign-in, after the sign-out and on "Check again", and the
    // fake login page's missing icon.
    const failed = `Failed to load resource: the server responded with a status of 500 (Internal Server Error) (${site.origin}/auth/logout)`
    const refused = `Failed to load resource: the server responded with a status of 401 (Unauthorized) (${site.origin}/api/auth/me)`
    const noIcon = `Failed to load resource: the server responded with a status of 404 (Not Found) (${site.origin}/favicon.ico)`
    expect(errors.filter((error) => error !== `a: ${noIcon}`).sort()).toEqual(
      [
        ...Array.from({ length: 3 }, () => `a: ${failed}`),
        ...Array.from({ length: 3 }, () => `a: ${refused}`),
        `b: ${refused}`,
      ].sort(),
    )
  } finally {
    await context.close()
  }
})
