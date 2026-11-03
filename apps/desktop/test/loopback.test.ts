import { CindlError } from '@cindl/contracts'
import { canonicalLoopbackRedirect } from '@cindl/hermes-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '../src/main/log.ts'
import {
  CALLBACK_PATH,
  createLoopbackAuthorizer,
  LOOPBACK_HOST,
} from '../src/main/platform/loopback.ts'
import { rawGet } from './support/fake-hermes.ts'

const STATE = 'state-0123456789abcdef-synthetic'
const HERMES = 'https://hermes.example.test'

/** Builds an authorize URL the way the native sign-in does. */
const buildUrl =
  (state = STATE) =>
  (redirectUri: string) => {
    const url = new URL('/auth/native/authorize', HERMES)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return url.href
  }

/** Starts a sign-in and hands back the listener's port once the "browser" is opened. */
function start(
  options: { timeoutMs?: number; openBrowser?: (url: string) => Promise<void> } = {},
) {
  const lines: string[] = []
  let opened: (url: string) => void = () => undefined
  const browser = new Promise<string>((resolve) => (opened = resolve))
  const authorizer = createLoopbackAuthorizer({
    openBrowser:
      options.openBrowser ??
      ((url) => {
        opened(url)
        return Promise.resolve()
      }),
    log: createLogger({ write: (line) => lines.push(line) }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const result = authorizer.authorize(buildUrl())
  const port = browser.then((url) => {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri') as string)
    return Number(redirect.port)
  })
  return { authorizer, result, port, browser, lines }
}

const refused = (port: number) =>
  rawGet(port, `${CALLBACK_PATH}?state=${STATE}&code=late`).then(
    () => 'answered',
    (error: NodeJS.ErrnoException) => error.code,
  )

let pending: Array<Promise<unknown>> = []
afterEach(async () => {
  await Promise.allSettled(pending)
  pending = []
})

describe('loopback sign-in listener', () => {
  it('uses a canonical 127.0.0.1 redirect URI that Hermes accepts', async () => {
    const { browser, result, port } = start()
    pending.push(result)
    const redirect = new URL(
      new URL(await browser).searchParams.get('redirect_uri') as string,
    )
    expect(redirect.hostname).toBe(LOOPBACK_HOST)
    expect(redirect.pathname).toBe(CALLBACK_PATH)
    expect(canonicalLoopbackRedirect(redirect.href)).toBe(redirect.href)
    await rawGet(await port, `${CALLBACK_PATH}?state=${STATE}&code=c1`, {
      Host: `127.0.0.1:${await port}`,
    })
    await result
  })

  it('accepts only the matching state, then answers once and closes', async () => {
    const { result, port, lines } = start()
    const p = await port
    const host = { Host: `127.0.0.1:${p}` }
    const wrong = await rawGet(
      p,
      `${CALLBACK_PATH}?state=forged-state-value&code=evil`,
      host,
    )
    expect(wrong.status).toBe(400)
    const missing = await rawGet(p, `${CALLBACK_PATH}?code=evil`, host)
    expect(missing.status).toBe(400)
    const right = await rawGet(
      p,
      `${CALLBACK_PATH}?code=synthetic-code&state=${STATE}`,
      host,
    )
    expect(right.status).toBe(200)
    expect(right.body).toContain('return to Cindl')
    expect(await result).toBe(
      `http://127.0.0.1:${p}${CALLBACK_PATH}?code=synthetic-code&state=${STATE}`,
    )
    expect(await refused(p)).toBe('ECONNREFUSED')
    expect(lines.join('\n')).toContain('unexpected state')
    expect(lines.join('\n')).not.toContain('forged-state-value')
  })

  it('ignores other paths, methods, hosts and absolute-form targets', async () => {
    const { result, port } = start()
    const p = await port
    const host = { Host: `127.0.0.1:${p}` }
    expect((await rawGet(p, `/other?state=${STATE}&code=x`, host)).status).toBe(404)
    expect(
      (await rawGet(p, `${CALLBACK_PATH}?state=${STATE}&code=x`, host, 'POST')).status,
    ).toBe(405)
    // DNS rebinding: a page on another name that resolves to 127.0.0.1.
    const rebound = { Host: `evil.example.test:${p}` }
    expect(
      (await rawGet(p, `${CALLBACK_PATH}?state=${STATE}&code=x`, rebound)).status,
    ).toBe(400)
    expect(
      (
        await rawGet(
          p,
          `http://evil.example.test${CALLBACK_PATH}?state=${STATE}&code=x`,
          host,
        )
      ).status,
    ).toBe(400)
    // Still waiting for the real callback.
    expect(
      (await rawGet(p, `${CALLBACK_PATH}?state=${STATE}&code=ok`, host)).status,
    ).toBe(200)
    expect(await result).toContain('code=ok')
  })

  it('answers malformed targets with 400 and keeps waiting', async () => {
    const { result, port } = start()
    const p = await port
    const host = { Host: `127.0.0.1:${p}` }
    for (const target of [
      `//:99999${CALLBACK_PATH}`,
      `//[${CALLBACK_PATH}`,
      '//evil/callback',
    ])
      expect((await rawGet(p, target, host)).status).toBe(400)
    expect(
      (await rawGet(p, `${CALLBACK_PATH}?state=${STATE}&code=ok`, host)).status,
    ).toBe(200)
    expect(await result).toContain('code=ok')
  })

  it('cancels a sign-in that is replaced while it is still starting', async () => {
    const opened: string[] = []
    const authorizer = createLoopbackAuthorizer({
      openBrowser: (url) => {
        opened.push(url)
        return Promise.resolve()
      },
    })
    const first = authorizer.authorize(buildUrl())
    const second = authorizer.authorize(buildUrl('second-state-0123456789abcdef'))
    expect(
      ((await first.catch((reason: unknown) => reason)) as CindlError).message,
    ).toContain('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('second-state')
    authorizer.cancel()
    await second.catch(() => undefined)
  })

  it('passes a provider error through to the caller and still closes', async () => {
    const { result, port } = start()
    const p = await port
    const reply = await rawGet(p, `${CALLBACK_PATH}?error=access_denied&state=${STATE}`, {
      Host: `127.0.0.1:${p}`,
    })
    expect(reply.body).toContain('did not complete')
    expect(await result).toContain('error=access_denied')
    expect(await refused(p)).toBe('ECONNREFUSED')
  })

  it('times out and closes the listener', async () => {
    const { result, port } = start({ timeoutMs: 50 })
    const p = await port
    const error = await result.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CindlError)
    expect((error as CindlError).code).toBe('timeout')
    expect(await refused(p)).toBe('ECONNREFUSED')
  })

  it('closes when the browser cannot be opened', async () => {
    const { result } = start({
      openBrowser: () => Promise.reject(new Error('no xdg-open')),
    })
    const error = await result.catch((reason: unknown) => reason)
    expect((error as CindlError).code).toBe('unavailable')
  })

  it('lets a new sign-in replace a pending one', async () => {
    const first = start()
    const p = await first.port
    const second = first.authorizer.authorize(buildUrl('second-state-0123456789abcdef'))
    pending.push(second.catch(() => undefined))
    const error = await first.result.catch((reason: unknown) => reason)
    expect((error as CindlError).message).toContain('cancelled')
    expect(await refused(p)).toBe('ECONNREFUSED')
    first.authorizer.cancel()
    expect(
      ((await second.catch((reason: unknown) => reason)) as CindlError).message,
    ).toContain('cancelled')
  })

  it('refuses an authorize URL without this redirect URI or a real state', async () => {
    const authorizer = createLoopbackAuthorizer({ openBrowser: () => Promise.resolve() })
    await expect(authorizer.authorize(buildUrl('short'))).rejects.toThrow(/state/)
    await expect(
      authorizer.authorize(() => `${HERMES}/auth/native/authorize?state=${STATE}`),
    ).rejects.toThrow(/redirect_uri/)
  })
})
