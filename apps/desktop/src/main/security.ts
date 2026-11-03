import type { Session, WebContents } from 'electron'
import type { ExternalOpener } from './external.ts'
import type { GestureTracker } from './guards.ts'
import type { Logger } from './log.ts'
import { APP_HOST, APP_SCHEME } from './protocol.ts'

/** True for URLs on the app's own origin (`app://cindl/...`). */
export function isAppUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === `${APP_SCHEME}:` &&
      url.host === APP_HOST &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

/** Requests the renderer's session may never make: it talks to main, not the network. */
export const BLOCKED_REQUEST_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']

/**
 * A proxy that cannot work (the discard port on loopback, with loopback not
 * exempted) for anything the renderer's session might still reach without
 * webRequest seeing it, such as WebRTC TURN over TCP. Main's own Hermes
 * traffic uses Node's fetch and ws, not this session.
 */
export const DEAD_PROXY = {
  mode: 'fixed_servers',
  proxyRules: '127.0.0.1:9',
  proxyBypassRules: '<-loopback>',
} as const

/**
 * Session-wide defaults for the renderer: every permission request and check
 * is denied, device pickers are cancelled, downloads are blocked, the
 * spellchecker is off (Chromium's per-launch component request still goes to
 * the dead proxy, which refuses it), no HTTP(S)/WS(S) request leaves the
 * renderer (the CSP already forbids it; this holds even if the CSP did not),
 * and anything else goes to a proxy that cannot connect.
 */
export async function hardenSession(session: Session, log: Logger): Promise<void> {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    log.debug('Denied a permission request', { permission })
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.setDisplayMediaRequestHandler((_request, callback) => callback(null))
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  session.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault()
    callback('')
  })
  session.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  session.on('will-download', (event) => {
    log.warn('Blocked a download from the renderer')
    event.preventDefault()
  })
  session.setSpellCheckerEnabled(false)
  await session.setProxy(DEAD_PROXY)
  session.webRequest.onBeforeRequest(
    { urls: BLOCKED_REQUEST_URLS },
    (details, callback) => {
      log.warn('Blocked a network request from the renderer', {
        scheme: details.url.split(':')[0],
      })
      callback({ cancel: true })
    },
  )
}

/**
 * Per-webContents rules: no navigation away from the app, no new windows,
 * no webviews, WebRTC only through the dead proxy. Links the renderer opens
 * in a new window (Markdown links use target="_blank") go to the system
 * browser through the validated opener, and only right after a click or
 * Enter/Space that main saw; a plain navigation away from the app is blocked.
 */
export function hardenWebContents(
  contents: WebContents,
  options: { external: ExternalOpener; gestures: GestureTracker; log: Logger },
): void {
  const { external, gestures, log } = options
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.on('input-event', (_event, input) => gestures.pointer(input.type))
  contents.on('before-input-event', (_event, input) =>
    gestures.key(input.type, input.key),
  )
  contents.setWindowOpenHandler(({ url }) => {
    void external.open(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return
    event.preventDefault()
    log.warn('Blocked navigation away from the app')
  })
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame && isAppUrl(event.url)) return
    event.preventDefault()
  })
  contents.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
}
