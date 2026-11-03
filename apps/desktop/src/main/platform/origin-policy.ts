import { CindlError, HermesOrigin } from '@cindl/contracts'

/**
 * Where Cindl desktop may send Hermes credentials, defined once by the
 * contract's `HermesOrigin` schema: https, or plain http only to this
 * device's loopback addresses (127.0.0.1, [::1]); no credentials, path,
 * query or fragment; normalized to the bare origin, which is all Cindl
 * stores. The same rule covers the origin a user types, the origin stored on
 * disk (re-checked before every use), the sign-in page and the WebSocket.
 */
export function normalizeHermesOrigin(raw: unknown): string {
  const parsed = HermesOrigin.safeParse(raw)
  if (parsed.success) return parsed.data
  throw new CindlError(
    'invalid',
    parsed.error.issues[0]?.message ??
      'Enter the address of your hermes serve backend, for example https://hermes.example.test.',
  )
}

/** The stored origin if it is still exactly a normalized, allowed origin; never throws. */
export function trustedStoredOrigin(value: string | undefined): string | undefined {
  const parsed = HermesOrigin.safeParse(value)
  return parsed.success && parsed.data === value ? parsed.data : undefined
}

/**
 * True when a request URL (http, https, ws or wss) goes to an origin the
 * policy allows, so nothing secret crosses the network unencrypted.
 */
export function usesSecureTransport(url: URL): boolean {
  const scheme =
    url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  if (scheme !== 'https:' && scheme !== 'http:') return false
  return HermesOrigin.safeParse(`${scheme}//${url.host}`).success
}
