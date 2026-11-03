import type { CindlClientApi, DesktopBridge } from '@cindl/contracts'

declare global {
  interface Window {
    cindlDesktop?: DesktopBridge
  }
}

export type ClientResolution =
  | { kind: 'desktop'; api: CindlClientApi; bridge: DesktopBridge }
  | { kind: 'demo'; api: CindlClientApi }
  | { kind: 'unavailable'; reason: 'same-origin-pending' }

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
        call: (name, args) => bridge.call(name, args),
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
