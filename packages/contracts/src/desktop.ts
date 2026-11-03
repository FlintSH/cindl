import type { CindlEvent } from './events.ts'
import type { OpArgs, OpName, OpResult } from './ops.ts'

/**
 * The only object the Electron preload exposes to the renderer, as
 * `window.cindlDesktop`. Tokens, Hermes URLs with tickets and Node APIs stay
 * in the main process; the renderer can call allowlisted `clientOps` only,
 * and main re-validates every call with `parseOpArgs`.
 */
export interface DesktopBridge {
  readonly kind: 'cindl-desktop'
  readonly bridgeVersion: 1
  readonly platform: 'linux' | 'win32' | 'darwin'
  /**
   * Rejects with a plain `CindlErrorShape` object, not an Error: contextBridge
   * does not carry Error identity or custom properties across the boundary.
   * Renderers revive it (apps/web/src/platform/client.ts `reviveError`).
   */
  call<K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>>
  subscribe(listener: (event: CindlEvent) => void): () => void
  /**
   * Native save dialog for text the renderer already holds (e.g. an exported
   * transcript). Call it from a click or key handler: main opens one dialog per
   * gesture it saw and otherwise resolves `{ saved: false }`.
   */
  saveText(suggestedName: string, content: string): Promise<{ saved: boolean }>
  /** Opens an https URL in the system browser after main-process validation. */
  openExternal(url: string): Promise<{ opened: boolean }>
}

/** IPC channel names. Main rejects any other channel and any non-app sender. */
export const desktopChannels = {
  call: 'cindl:call',
  event: 'cindl:event',
  saveText: 'cindl:save-text',
  openExternal: 'cindl:open-external',
} as const
