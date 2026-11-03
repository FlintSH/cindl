import { HERMES_BASELINE } from '@cindl/contracts'

/**
 * Hermes WebSocket subprotocols (tui_gateway/ws.py at v0.22.5). The ticket
 * rides in a subprotocol rather than the URL so it never lands in access
 * logs. Both strings are secrets for diagnostics purposes (see redact.ts).
 */
export const GATEWAY_SUBPROTOCOL = 'hermes-gateway-v1'
export const ticketSubprotocol = (ticket: string) => `hermes-gateway-ticket.${ticket}`

/** REST endpoints Cindl reads or writes on `hermes serve` at v0.22.5. */
export const restEndpoints = {
  status: { method: 'GET', path: '/api/status', auth: 'public' },
  authProviders: { method: 'GET', path: '/api/auth/providers', auth: 'public' },
  authMe: { method: 'GET', path: '/api/auth/me', auth: 'session' },
  wsTicket: { method: 'POST', path: '/api/auth/ws-ticket', auth: 'session' },
  nativeAuthorize: { method: 'GET', path: '/auth/native/authorize', auth: 'public' },
  nativeToken: { method: 'POST', path: '/auth/native/token', auth: 'public' },
  nativeRefresh: { method: 'POST', path: '/auth/native/refresh', auth: 'public' },
  skills: { method: 'GET', path: '/api/skills', auth: 'session' },
  skillContent: { method: 'GET', path: '/api/skills/content', auth: 'session' },
  soul: { method: 'GET', path: '/api/profiles/{name}/soul', auth: 'session' },
  soulWrite: { method: 'PUT', path: '/api/profiles/{name}/soul', auth: 'session' },
  memory: { method: 'GET', path: '/api/memory', auth: 'session' },
} as const

export type RestEndpointName = keyof typeof restEndpoints

/** Single-use WebSocket ticket lifetime advertised by `POST /api/auth/ws-ticket`. */
export const WS_TICKET_TTL_SECONDS = 30

/** JSON-RPC error code for server requests Cindl does not implement. */
export const METHOD_NOT_FOUND = -32601

/** Display WebSocket close codes (tui_gateway display bridge, v0.22.5). */
export const displayCloseCodes = {
  evictedController: 4000,
  screenStopped: 4001,
  ticketRejected: 4401,
  originRejected: 4403,
  protocolError: 1003,
} as const

export const baseline = HERMES_BASELINE

/** True when the server identifies as the exact verified baseline. */
export function isBaselineVersion(version: string | undefined): boolean {
  return version?.replace(/^v/, '') === HERMES_BASELINE.version
}
