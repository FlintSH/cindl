import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  FIXTURE_LOGIN,
  startFakeHermes,
  type FakeHermes,
} from '@cindl/fixtures/fake-hermes'
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

/** Signs this browser in the way Hermes's own login page does: its form posts the password. */
async function signInOnHermes(page: Page) {
  const login = await page.request.post(`${site.origin}/auth/password-login`, {
    data: {
      provider: 'basic',
      username: FIXTURE_LOGIN.username,
      password: FIXTURE_LOGIN.password,
      next: '/cindl/',
    },
  })
  expect(login.ok()).toBe(true)
}

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

  // Hermes's login page would do this; its cookie is HttpOnly, for this origin.
  await signInOnHermes(page)
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'hermes_session_at',
  )
  // HttpOnly: the page itself can never read the session.
  expect(session?.httpOnly).toBe(true)
  await page.goto(`${site.origin}/cindl/`)
  await expect(page.getByRole('button', { name: 'Sign in on Hermes' })).toHaveCount(0)

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
  await allow.click()
  await expect.poll(() => outcome.result).toEqual({ choice: 'once' })
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0)

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

  // The browser's path only: the cookie, the ticket, the gateway; no native sign-in.
  const names = fake.calls.map((call) => call.name)
  expect(names).toEqual(
    expect.arrayContaining([
      'GET /api/status',
      'GET /api/auth/me',
      'POST /api/auth/ws-ticket',
      '/api/ws',
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
