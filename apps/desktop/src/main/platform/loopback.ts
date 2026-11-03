import type { LoopbackAuthorizer } from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'
import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from '../log.ts'

/**
 * The RFC 8252 loopback leg of native sign-in. Hermes v0.22.5 accepts only
 * `http://127.0.0.1[:port]` or `http://[::1][:port]` redirect URIs, so each
 * sign-in opens a short-lived listener on 127.0.0.1 and a random port. It
 * answers exactly one callback that carries the expected `state`, then
 * closes; it also closes on timeout or cancellation. Requests with another
 * state, path, method or Host header are refused and do not end the wait.
 */
export const LOOPBACK_HOST = '127.0.0.1'
export const CALLBACK_PATH = '/callback'
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60_000

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  Connection: 'close',
}

const page = (text: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Cindl sign-in</title><p>${text}</p></html>`

const PAGES = {
  received: page(
    'Cindl received the sign-in response. You can close this tab and return to Cindl.',
  ),
  failed: page('Sign-in did not complete. Return to Cindl to try again.'),
  mismatch: page('This sign-in response is not for the current Cindl request.'),
  refused: page('Not found.'),
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface LoopbackAuthorizerHandle extends LoopbackAuthorizer {
  /** Ends a pending sign-in, if any (its promise rejects). */
  cancel(): void
}

export function createLoopbackAuthorizer(options: {
  /** Opens the authorize URL in the system browser. */
  openBrowser(url: string): Promise<void>
  timeoutMs?: number
  log?: Logger
}): LoopbackAuthorizerHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS
  let cancelPending: (() => void) | undefined
  /** Increments per authorize(): a request superseded while binding gives up. */
  let latest = 0

  return {
    cancel() {
      cancelPending?.()
    },
    async authorize(buildUrl) {
      // One sign-in at a time: a new request replaces the previous one.
      cancelPending?.()
      const attempt = ++latest

      let expectedState: string | undefined
      let redirectUri = ''
      let complete: ((callbackUrl: string) => void) | undefined

      const server = http.createServer((request, response) => {
        const reply = (status: number, body: string) => {
          response.writeHead(status, PAGE_HEADERS)
          response.end(body)
        }
        const target = request.url ?? ''
        if (request.method !== 'GET') return reply(405, PAGES.refused)
        // Only origin-form targets (`//host/...` would name another authority)
        // on the exact loopback authority (no DNS rebinding).
        if (
          !target.startsWith('/') ||
          target.startsWith('//') ||
          request.headers.host !== new URL(redirectUri).host
        )
          return reply(400, PAGES.refused)
        let url: URL
        try {
          url = new URL(target, redirectUri)
        } catch {
          return reply(400, PAGES.refused)
        }
        if (url.pathname !== CALLBACK_PATH) return reply(404, PAGES.refused)
        const state = url.searchParams.get('state') ?? ''
        if (
          expectedState === undefined ||
          !complete ||
          !sameSecret(state, expectedState)
        ) {
          options.log?.warn('Ignored a sign-in callback with an unexpected state')
          return reply(400, PAGES.mismatch)
        }
        reply(200, url.searchParams.has('error') ? PAGES.failed : PAGES.received)
        complete(`${redirectUri}${url.search}`)
      })
      server.headersTimeout = 10_000
      server.requestTimeout = 10_000
      server.maxHeadersCount = 64

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
          server.off('error', reject)
          resolve()
        })
      })
      const shutdown = () => {
        server.close()
        server.closeAllConnections()
      }
      if (attempt !== latest) {
        shutdown()
        throw new CindlError('unavailable', 'Sign-in was cancelled.')
      }

      const { port } = server.address() as AddressInfo
      redirectUri = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`
      let authorizeUrl: string
      try {
        authorizeUrl = buildUrl(redirectUri)
        const parsed = new URL(authorizeUrl)
        const state = parsed.searchParams.get('state')
        if (
          parsed.searchParams.get('redirect_uri') !== redirectUri ||
          !state ||
          state.length < 16
        )
          throw new Error('authorize URL must carry this redirect_uri and a random state')
        expectedState = state
      } catch (error) {
        shutdown()
        throw error
      }

      return new Promise<string>((resolve, reject) => {
        let settled = false
        const finish = (settle: () => void) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (cancelPending === cancel) cancelPending = undefined
          shutdown()
          settle()
        }
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new CindlError(
                  'timeout',
                  'Sign-in was not completed in time. Start it again from Cindl.',
                ),
              ),
            ),
          timeoutMs,
        )
        const cancel = () =>
          finish(() => reject(new CindlError('unavailable', 'Sign-in was cancelled.')))
        cancelPending = cancel
        complete = (callbackUrl) => finish(() => resolve(callbackUrl))
        options.openBrowser(authorizeUrl).catch((error: unknown) => {
          options.log?.warn('Could not open the system browser for sign-in', error)
          finish(() =>
            reject(
              new CindlError(
                'unavailable',
                'Cindl could not open your browser for sign-in.',
              ),
            ),
          )
        })
      })
    },
  }
}
