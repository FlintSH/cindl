/**
 * Sign-in to another Hermes is all or nothing, and a keyring that stops
 * encrypting leaves nothing behind on disk. Regressions for the review of
 * 636a2dd (DP2, DP3, D12) against the fake `hermes serve` (harness:
 * support/desktop.ts). Fakes listen on OS-assigned loopback ports only.
 */
import type { CindlEvent } from '@cindl/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { ORIGIN_KEY } from '../src/main/platform/index.ts'
import {
  codeOf,
  desktop,
  fakeHermes,
  noKeyring,
  runCleanups,
  signIn,
  unreachableOrigin,
  userData,
  type Desktop,
} from './support/desktop.ts'

afterEach(runCleanups)

/** Online on `origin`, with the stored origin and the pin back on it. */
async function backOn(d: Desktop, origin: string) {
  await d.waitFor(() => d.link().phase === 'online' && d.link().server?.origin === origin)
  expect(await codeOf(d.real.client.call('conversations.list', {}))).toBe('resolved')
  expect(d.platform.origin()).toBe(origin)
  expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(origin)
}

const notices = (d: Desktop) =>
  d.events.filter(
    (event): event is Extract<CindlEvent, { type: 'notice' }> => event.type === 'notice',
  )

/** Whether a warning notice mentioning `text` reached the window. */
const warned = (d: Desktop, text: string) =>
  notices(d).some((notice) => notice.level === 'warning' && notice.message.includes(text))

const tokenRequests = (calls: ReadonlyArray<{ name: string }>) =>
  calls.filter((call) => call.name === 'POST /auth/native/token')

describe('signing in to another Hermes is all or nothing', { timeout: 30_000 }, () => {
  it('keeps the current session when the sign-in elsewhere fails (DP2)', async () => {
    const a = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, a.origin)
    const elsewhere = await unreachableOrigin()
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: elsewhere }))).toBe(
      'offline',
    )
    // Without a restart: pin, stored origin, tokens and the connection are A's.
    await backOn(d, a.origin)
    expect(d.secretEntries()).toEqual([expect.stringContaining(a.origin)])
    // The failure is reported in the window, whichever screen it shows.
    expect(warned(d, elsewhere), JSON.stringify(notices(d))).toBe(true)
  })

  it('keeps the current session when the sign-in elsewhere is cancelled in the browser', async () => {
    const a = await fakeHermes()
    const b = await fakeHermes({ nativeSignIn: 'deny' })
    const d = await desktop(userData())
    await signIn(d, a.origin)
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))).toBe(
      'unauthenticated',
    )
    await backOn(d, a.origin)
    expect(d.secretEntries()).toEqual([expect.stringContaining(a.origin)])
    expect(tokenRequests(b.calls)).toEqual([])
  })

  it('keeps the current session without a keyring too', async () => {
    const a = await fakeHermes()
    const d = await desktop(userData(), { safeStorage: noKeyring })
    await signIn(d, a.origin)
    const elsewhere = await unreachableOrigin()
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: elsewhere }))).toBe(
      'offline',
    )
    await backOn(d, a.origin)
  })

  it('stays on the old Hermes across a restart while or after a sign-in elsewhere fails (D12)', async () => {
    const a = await fakeHermes()
    const b = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    await signIn(d, a.origin)
    // Cindl quits while the browser leg for B is still open.
    d.openBrowser.mockImplementationOnce(() => Promise.resolve())
    const pending = codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))
    await d.waitFor(() => d.openBrowser.mock.calls.length === 2)
    const during = await desktop(dir)
    await during.waitFor(() => during.link().phase === 'online')
    expect(during.link().server?.origin).toBe(a.origin)
    during.real.stop()
    d.platform.authorizer.cancel()
    expect(await pending).toBe('unavailable')
    // And after a sign-in that failed or was cancelled.
    b.nativeSignIn = 'deny'
    await codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))
    await codeOf(d.real.client.call('auth.signIn', { origin: await unreachableOrigin() }))
    d.real.stop()
    const after = await desktop(dir)
    await after.waitFor(() => after.link().phase === 'online')
    expect(after.link().server?.origin).toBe(a.origin)
  })

  it('changes nothing when the owner refuses the confirmation', async () => {
    const a = await fakeHermes()
    const b = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, a.origin)
    d.confirmSignIn.mockResolvedValueOnce(false)
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))).toBe(
      'forbidden',
    )
    expect(b.calls).toEqual([])
    await backOn(d, a.origin)
  })

  it('returns a failed first sign-in to Not set up, with nothing stored', async () => {
    const d = await desktop(userData())
    const nowhere = await unreachableOrigin()
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: nowhere }))).toBe(
      'offline',
    )
    await d.waitFor(() => d.link().phase === 'unconfigured')
    expect(d.platform.origin()).toBeUndefined()
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBeUndefined()
  })

  it('returns a cancelled sign-in to the same Hermes to signed out, not a stuck connecting', async () => {
    const a = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, a.origin)
    await d.real.client.call('auth.signOut', {})
    a.nativeSignIn = 'deny'
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: a.origin }))).toBe(
      'unauthenticated',
    )
    await d.waitFor(() => d.link().phase === 'signed-out')
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(a.origin)
    a.nativeSignIn = 'approve'
    await signIn(d, a.origin)
  })

  it('lets a newer sign-in replace one still waiting for the browser', async () => {
    const a = await fakeHermes()
    const b = await fakeHermes()
    const c = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, a.origin)
    // The browser leg for B never comes back (a closed tab).
    d.openBrowser.mockImplementationOnce(() => Promise.resolve())
    const first = codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))
    await d.waitFor(() => d.openBrowser.mock.calls.length === 2)
    await d.real.client.call('auth.signIn', { origin: c.origin })
    expect(await first).toBe('unavailable')
    await backOn(d, c.origin)
    // A's tokens went when C succeeded; B never got any.
    expect(d.secretEntries()).toEqual([expect.stringContaining(c.origin)])
    expect(tokenRequests(b.calls)).toEqual([])
  })

  it('switches, warns and removes the old tokens at the next start when they cannot be removed at once', async () => {
    const a = await fakeHermes()
    const b = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    await signIn(d, a.origin)
    const remove = d.platform.secrets.delete.bind(d.platform.secrets)
    d.platform.secrets.delete = (key) =>
      key.includes(a.origin)
        ? Promise.reject(new Error('disk full (fixture)'))
        : remove(key)
    await signIn(d, b.origin)
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(b.origin)
    expect(warned(d, a.origin), JSON.stringify(notices(d))).toBe(true)
    d.real.stop()
    const again = await desktop(dir)
    await again.waitFor(() => again.link().phase === 'online')
    expect(again.link().server?.origin).toBe(b.origin)
    expect(again.secretEntries()).toEqual([expect.stringContaining(b.origin)])
  })

  it('undoes a switch whose new address cannot be saved', async () => {
    const a = await fakeHermes()
    const b = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, a.origin)
    const set = d.platform.kv.set.bind(d.platform.kv)
    d.platform.kv.set = (key, value) =>
      key === ORIGIN_KEY
        ? Promise.reject(new Error('disk full (fixture)'))
        : set(key, value)
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))).toBe(
      'internal',
    )
    await backOn(d, a.origin)
    expect(d.secretEntries()).toEqual([expect.stringContaining(a.origin)])
  })

  it('cancels a sign-in that is still waiting when the owner signs out', async () => {
    const a = await fakeHermes()
    const b = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, a.origin)
    d.openBrowser.mockImplementationOnce(() => Promise.resolve())
    const pending = codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))
    await d.waitFor(() => d.openBrowser.mock.calls.length === 2)
    expect(await d.real.client.call('auth.signOut', {})).toEqual({ localOnly: true })
    expect(await pending).toBe('unavailable')
    await d.waitFor(() => d.link().phase === 'signed-out')
    expect(d.link().server?.origin).toBe(a.origin)
    expect(d.secretEntries()).toEqual([])
  })
})
