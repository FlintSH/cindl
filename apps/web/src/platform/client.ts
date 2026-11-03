import type { DirectClient } from '@cindl/client-core'
import {
  CindlError,
  CindlErrorShape,
  HermesOrigin,
  type CindlClientApi,
  type DesktopBridge,
} from '@cindl/contracts'

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
  | { kind: 'unavailable'; reason: 'same-origin-pending' }

/**
 * Whether this page's own origin is a `hermes serve` that signs browsers in
 * with its session cookie: its public `GET /api/status` answers with Hermes's
 * shape and offers the `cookie` flow. Anything else (a 404, another server, a
 * network error, no cookie flow) means Cindl is not mounted under Hermes.
 */
export async function hermesAtThisOrigin(
  fetchStatus: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    window.fetch(url, init),
  origin: string = window.location.origin,
): Promise<boolean> {
  try {
    const response = await fetchStatus(`${origin}/api/status`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return false
    const status: unknown = await response.json()
    if (typeof status !== 'object' || status === null) return false
    const { version, auth_flows: flows } = status as {
      version?: unknown
      auth_flows?: unknown
    }
    return typeof version === 'string' && Array.isArray(flows) && flows.includes('cookie')
  } catch {
    return false
  }
}

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
  if (origin.success && (await hermesAtThisOrigin(undefined, origin.data))) {
    const { createSameOriginClient } = await import('./browser.ts')
    return { kind: 'hermes', api: createSameOriginClient(origin.data) }
  }
  // Served anywhere else, a browser cannot reach Hermes (no CORS, by design):
  // Cindl needs mounting on Hermes's own origin (see the handbook).
  return { kind: 'unavailable', reason: 'same-origin-pending' }
}
