/**
 * What a platform must provide to run the direct Hermes client. Web, the
 * Electron main process and Android implement these; nothing else in the
 * client touches globals, so every platform runs the same logic.
 */

/** Non-secret persistent key-value storage (preferences, outbox, answered-request ledger). */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * OS-backed secret storage: Android Keystore (expo-secure-store), Electron
 * safeStorage in the main process. Browsers have none: the web client relies
 * on Hermes's same-origin HttpOnly cookie and stores no tokens.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /** False when the OS cannot encrypt (e.g. no keyring); callers must not fall back to plaintext. */
  readonly available: boolean
}

export interface WebSocketLike {
  readonly readyState: number
  readonly protocol: string
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike

/** Runs the RFC 8252 loopback leg: opens the system browser and resolves with the callback URL. */
export interface LoopbackAuthorizer {
  authorize(buildUrl: (redirectUri: string) => string): Promise<string>
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
