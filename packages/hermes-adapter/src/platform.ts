/**
 * The platform services the adapter needs. These are structural copies of the
 * interfaces in `@cindl/client-core` (`src/platform.ts`): client-core depends
 * on this package, so importing them back would create a package cycle.
 * `client-core/src/direct` asserts at compile time that its platform types
 * still satisfy these.
 */

export interface SocketLike {
  readonly readyState: number
  readonly protocol: string
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** Opens a WebSocket with the given subprotocols. Must not add a ticket to the URL. */
export type SocketFactory = (url: string, protocols: string[]) => SocketLike

export interface Timers {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** OS-backed secret storage. `available: false` means memory only, never plaintext. */
export interface SecretVault {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  readonly available: boolean
}

/** Runs the RFC 8252 loopback leg and resolves with the callback URL. */
export interface LoopbackLeg {
  authorize(buildUrl: (redirectUri: string) => string): Promise<string>
  /** Ends the wait of the attempt under way, if any: its promise rejects. */
  cancel?(): void
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** WebSocket readyState values (identical in browsers, React Native, undici and ws). */
export const SOCKET_OPEN = 1
