import type { Page } from '@playwright/test'

/**
 * The renderer as the desktop app loads it, with a synthetic preload bridge in
 * place of Electron's. Nothing here reaches Hermes: the bridge records calls
 * and rejects them with the plain objects contextBridge delivers.
 */
export interface Probe {
  bridgeCalls: Array<{ name: string; args: unknown }>
  bridgeEmit: (event: unknown) => void
}

export async function openDesktopRenderer(
  page: Page,
  link: { phase: 'unconfigured' | 'signed-out'; origin?: string } = {
    phase: 'unconfigured',
  },
) {
  await page.addInitScript((initial) => {
    type Listener = (event: unknown) => void
    const listeners = new Set<Listener>()
    const probe: Probe = {
      bridgeCalls: [],
      bridgeEmit: (event) => listeners.forEach((listener) => listener(event)),
    }
    Object.assign(window, {
      cindlProbe: probe,
      cindlDesktop: {
        kind: 'cindl-desktop',
        bridgeVersion: 1,
        platform: 'linux',
        call(name: string, args: unknown) {
          probe.bridgeCalls.push({ name, args })
          // contextBridge delivers rejections as plain objects; that is what this replays.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(
            name === 'auth.signIn'
              ? {
                  name: 'CindlError',
                  code: 'unavailable',
                  message: 'The system browser could not be opened.',
                }
              : { name: 'CindlError', code: 'unsupported', message: `${name} (test)` },
          )
        },
        subscribe(listener: Listener) {
          listeners.add(listener)
          queueMicrotask(() =>
            listener({
              type: 'link.changed',
              link: {
                phase: initial.phase,
                since: '2026-01-01T00:00:00.000Z',
                connectionEpoch: 0,
                ...(initial.origin ? { server: { origin: initial.origin } } : {}),
              },
            }),
          )
          return () => listeners.delete(listener)
        },
      },
    })
  }, link)
  await page.goto('/')
  await page.getByRole('main').waitFor()
}

export const bridgeCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { cindlProbe: Probe }).cindlProbe.bridgeCalls)
export const emit = (page: Page, event: unknown) =>
  page.evaluate(
    (e) => (window as unknown as { cindlProbe: Probe }).cindlProbe.bridgeEmit(e),
    event,
  )
export const tokenNotice = {
  type: 'notice',
  level: 'warning',
  message: 'Tokens are kept in memory only on this machine.',
}
