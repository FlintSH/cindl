import { HERMES_BASELINE } from '@cindl/contracts'

/**
 * Hermes WebSocket subprotocols (hermes_cli/web_server_boundary.py:151-152,
 * parsed at :155-166; accepted in web_server_chat.py:265-283 at v0.22.5). The
 * ticket rides in a subprotocol rather than the URL so it never lands in
 * access logs; the server echoes only `hermes-gateway-v1`. Both strings are
 * secrets for diagnostics purposes (see redact.ts).
 */
export const GATEWAY_SUBPROTOCOL = 'hermes-gateway-v1'
export const ticketSubprotocol = (ticket: string) => `hermes-gateway-ticket.${ticket}`

/** WebSocket paths on `hermes serve` (hermes_cli/web_routers/chat_ws.py:702, display.py:73). */
export const wsPaths = { gateway: '/api/ws', display: '/api/display/ws' } as const

/**
 * REST endpoints Cindl reads or writes on `hermes serve` at v0.22.5. `auth`:
 * `public` needs no session; `session` accepts the same-origin cookie or a
 * native `Authorization: Bearer` access token (dashboard_auth/middleware.py:171-184).
 */
export const restEndpoints = {
  status: { method: 'GET', path: '/api/status', auth: 'public' },
  authProviders: { method: 'GET', path: '/api/auth/providers', auth: 'public' },
  authMe: { method: 'GET', path: '/api/auth/me', auth: 'session' },
  wsTicket: { method: 'POST', path: '/api/auth/ws-ticket', auth: 'session' },
  nativeAuthorize: { method: 'GET', path: '/auth/native/authorize', auth: 'public' },
  nativeToken: { method: 'POST', path: '/auth/native/token', auth: 'public' },
  nativeRefresh: { method: 'POST', path: '/auth/native/refresh', auth: 'public' },
  sessionMutationSnapshot: {
    method: 'GET',
    path: '/api/sessions/{id}/mutation-snapshot',
    auth: 'session',
  },
  sessionPatch: { method: 'PATCH', path: '/api/sessions/{id}', auth: 'session' },
  skills: { method: 'GET', path: '/api/skills', auth: 'session' },
  skillContent: { method: 'GET', path: '/api/skills/content', auth: 'session' },
  skillContentWrite: { method: 'PUT', path: '/api/skills/content', auth: 'session' },
  soul: { method: 'GET', path: '/api/profiles/{name}/soul', auth: 'session' },
  soulWrite: { method: 'PUT', path: '/api/profiles/{name}/soul', auth: 'session' },
  memory: { method: 'GET', path: '/api/memory', auth: 'session' },
  /**
   * Per-entry memory (web_routers/status.py:693-743). Node ids that do not
   * start with `memory:` address skills on the same routes, so the adapter
   * only ever sends fingerprinted memory ids (see memory-entries.ts).
   */
  learningGraph: { method: 'GET', path: '/api/learning/graph', auth: 'session' },
  learningNode: { method: 'GET', path: '/api/learning/node', auth: 'session' },
  learningNodeWrite: { method: 'PUT', path: '/api/learning/node', auth: 'session' },
  learningNodeDelete: { method: 'DELETE', path: '/api/learning/node', auth: 'session' },
} as const

export type RestEndpointName = keyof typeof restEndpoints

/** Single-use WebSocket ticket lifetime advertised by `POST /api/auth/ws-ticket`. */
export const WS_TICKET_TTL_SECONDS = 30

/** JSON-RPC error code for server requests Cindl does not implement. */
export const METHOD_NOT_FOUND = -32601

/**
 * Hermes's default request windows: approvals 300 s (tools/approval_context.py:305-313,
 * `approvals.timeout`), clarify 3600 s (tools/clarify_gateway.py:296-308). Both are
 * operator-configurable. Hermes fails closed and announces the end of a wait
 * with `request.cancel`, which is what Cindl treats as authoritative; it does
 * not guess a local deadline.
 */
export const DEFAULT_APPROVAL_WINDOW_SECONDS = 300
export const DEFAULT_CLARIFY_WINDOW_SECONDS = 3600

/** Display WebSocket close codes (hermes_cli/web_routers/display.py:37-42, v0.22.5). */
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

/** Expand `{name}`-style placeholders with URL-encoded values. */
export function endpointPath(
  name: RestEndpointName,
  params: Record<string, string> = {},
) {
  return restEndpoints[name].path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key]
    if (value === undefined || value === '')
      throw new Error(`Missing path parameter ${key} for ${name}`)
    return encodeURIComponent(value)
  })
}
