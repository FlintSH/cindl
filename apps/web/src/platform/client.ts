import {
  CindlError,
  CindlErrorShape,
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
  | { kind: 'unavailable'; reason: 'same-origin-pending' }

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
  // A same-origin Hermes client needs Cindl mounted under `hermes serve`, which
  // is a deployment decision that has not been made (see the handbook).
  return { kind: 'unavailable', reason: 'same-origin-pending' }
}
