import type { DirectClient } from '@cindl/client-core'
import {
  CindlError,
  CindlErrorShape,
  HermesOrigin,
  type CindlClientApi,
  type DesktopBridge,
} from '@cindl/contracts'
import { loginPagePath } from '@cindl/hermes-adapter'
import { createSameOriginClient } from './browser.ts'

declare global {
  interface Window {
    cindlDesktop?: DesktopBridge
  }
}

export type ClientResolution =
  | { kind: 'desktop'; api: CindlClientApi; bridge: DesktopBridge }
  | { kind: 'demo'; api: CindlClientApi }
  /** Served from its Hermes's own origin: Hermes's session cookie signs it in. */
  | { kind: 'hermes'; api: DirectClient }
  | { kind: 'unavailable'; reason: Unavailable }

/** Why the web client is not connected, from what the page's origin answered. */
export type Unavailable =
  /** No Hermes here (a 404, a page, another server): not served from a Hermes origin. */
  | 'not-mounted'
  /** Hermes did not answer: a network error, no answer in time, or a 5xx while it restarts. */
  | 'no-answer'
  /** Hermes answered without the browser sign-in (loopback-token mode, or still starting). */
  | 'no-sign-in'
  /** Plain http away from this machine: Cindl never signs in to Hermes there. */
  | 'insecure-origin'

/** What this page's origin said to Hermes's public status check. */
export type StatusAnswer = 'hermes' | 'not-hermes' | 'no-answer' | 'no-sign-in'

/** How long the status check waits before calling it "no answer". */
export const STATUS_TIMEOUT_MS = 5000

/**
 * Asks this page's own origin for Hermes's public `GET /api/status`. Only a
 * Hermes-shaped answer offering the `cookie` flow is Hermes a browser can
 * sign in to; a failure to answer is told apart from an answer that is not
 * Hermes, so a restart is never reported as "not mounted".
 */
export async function probeThisOrigin(
  fetchStatus: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    window.fetch(url, init),
  origin: string = window.location.origin,
): Promise<StatusAnswer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
  try {
    const response = await fetchStatus(`${origin}/api/status`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status >= 500) return 'no-answer'
    if (!response.ok) return 'not-hermes'
    let status: unknown
    try {
      status = await response.json()
    } catch {
      return controller.signal.aborted ? 'no-answer' : 'not-hermes'
    }
    if (typeof status !== 'object' || status === null) return 'not-hermes'
    const { version, auth_flows: flows } = status as {
      version?: unknown
      auth_flows?: unknown
    }
    if (typeof version !== 'string' || !Array.isArray(flows)) return 'not-hermes'
    return flows.includes('cookie') ? 'hermes' : 'no-sign-in'
  } catch {
    return 'no-answer'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Where Hermes's login page sends the browser back to: this build's own
 * directory (the mount, such as `/cindl/`) and the view, never a query or
 * whatever else the page was loaded at. Hermes decodes `next` once more on an
 * OAuth sign-in than on a password one, so a view whose address holds a `%`
 * could come back as another view: it returns to the mount alone.
 */
export const returnPath = () => {
  const mount = new URL('./', window.location.href).pathname
  const view = window.location.hash
  return view.includes('%') ? mount : `${mount}${view}`
}

/**
 * Hermes's own sign-in page, returning here. loginPagePath drops an unsafe
 * `next` and escapes it for the decodes Hermes applies on a password sign-in.
 */
export const hermesSignInPage = () => loginPagePath(returnPath())

export function reviveError(err: unknown): Error {
  if (err instanceof Error) return err
  const shape = CindlErrorShape.safeParse(err)
  return shape.success
    ? new CindlError(shape.data.code, shape.data.message, shape.data.detail)
    : new CindlError('internal', 'The desktop app reported an unexpected error.')
}

/**
 * Picks the client for this runtime. There is no silent fallback to fixtures:
 * the synthetic demo runs only when explicitly requested at build time
 * (VITE_CINDL_DEMO=1), and it always shows a banner.
 */
export async function resolveClient(): Promise<ClientResolution> {
  const bridge = window.cindlDesktop
  if (bridge?.kind === 'cindl-desktop' && bridge.bridgeVersion === 1)
    return {
      kind: 'desktop',
      bridge,
      api: {
        // contextBridge drops Error identity: rejections arrive as plain
        // CindlErrorShape objects and are revived so callers can switch on code.
        call: (name, args) =>
          bridge
            .call(name, args)
            .catch((err: unknown) => Promise.reject(reviveError(err))),
        subscribe: (listener) => bridge.subscribe(listener),
      },
    }
  if (import.meta.env.VITE_CINDL_DEMO === '1') {
    const { createScenarioClient } = await import('@cindl/fixtures/scenario')
    return { kind: 'demo', api: createScenarioClient() }
  }
  // Mounted under `hermes serve` (same origin): the browser's own Hermes session.
  // Only on an origin Cindl accepts for Hermes (https, or http on a loopback IP).
  const origin = HermesOrigin.safeParse(window.location.origin)
  if (!origin.success) return { kind: 'unavailable', reason: 'insecure-origin' }
  const answer = await probeThisOrigin(undefined, origin.data)
  if (answer === 'hermes')
    return { kind: 'hermes', api: createSameOriginClient(origin.data) }
  // Served anywhere else, a browser cannot reach Hermes (no CORS, by design):
  // Cindl needs mounting on Hermes's own origin (see the handbook).
  return { kind: 'unavailable', reason: answer === 'not-hermes' ? 'not-mounted' : answer }
}
