import { CindlError } from '@cindl/contracts'
import type { FetchLike } from '@cindl/hermes-adapter'

/**
 * Hermes origins Cindl for Android may contact. HTTPS everywhere; plain HTTP
 * only for the device's own loopback IP literals (127.0.0.1, [::1]), matching
 * the network security config written by plugins/withNetworkSecurity.ts.
 * `localhost` is refused: it is a name, not a guaranteed loopback address.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

export type OriginCheck = { ok: true; origin: string } | { ok: false; reason: string }

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/** Accepts what an owner types ("hermes.example.test") and returns a canonical origin. */
export function normalizeOrigin(input: string): OriginCheck {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, reason: 'Enter the address of your Hermes server.' }
  if (/[?#]/.test(trimmed))
    return { ok: false, reason: 'Enter only the server address, without a path.' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'That is not a valid address.' }
  }
  if (url.username || url.password)
    return { ok: false, reason: 'Remove the user name or password from the address.' }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false, reason: 'Use an https:// address.' }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
    return {
      ok: false,
      reason:
        'Use https://. Plain http is allowed only for this device itself (127.0.0.1 or [::1]).',
    }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    return { ok: false, reason: 'Enter only the server address, without a path.' }
  return { ok: true, origin: url.origin }
}

/** True for URLs this app may fetch or open a socket to (same rules as origins). */
export function isAllowedHermesUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true
  return (
    (url.protocol === 'http:' || url.protocol === 'ws:') && isLoopbackHost(url.hostname)
  )
}

/**
 * Requests reach only https origins, or http on this device's own loopback
 * address (the same rule as sockets and the network security config).
 */
export function guardFetch(fetch: FetchLike): FetchLike {
  return (url, init) =>
    isAllowedHermesUrl(url)
      ? fetch(url, init)
      : Promise.reject(
          new CindlError(
            'invalid',
            'Not sent: Cindl only talks to Hermes over https (or http on this device).',
          ),
        )
}
