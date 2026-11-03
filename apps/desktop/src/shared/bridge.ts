import type { CindlErrorShape } from '@cindl/contracts'

/**
 * What main returns for every `invoke` on the desktop channels. Main never
 * throws across IPC (Electron would leak its own error text and stack); the
 * preload turns `ok: false` into a rejected promise for the renderer.
 */
export type BridgeReply<T> =
  { ok: true; value: T } | { ok: false; error: CindlErrorShape }

/**
 * Renderer-to-main messages on `desktopChannels.event`. `subscribe` asks main
 * for a snapshot of the current state followed by live events; `unsubscribe`
 * stops delivery. Main ignores anything else.
 */
export const eventSignals = ['subscribe', 'unsubscribe'] as const
export type EventSignal = (typeof eventSignals)[number]

export const isEventSignal = (value: unknown): value is EventSignal =>
  value === 'subscribe' || value === 'unsubscribe'
