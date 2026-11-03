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

/** WebSocket paths on `hermes serve` (hermes_cli/web_routers/chat_ws.py:702, display.py:75). */
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
  /**
   * Hermes's own login page (dashboard_auth/routes.py:195-200). The web client
   * sends the browser here, so Cindl never sees a password; the page posts
   * `/auth/password-login` and Hermes sets the session cookies. `next` is
   * honoured only as a safe same-origin path (`loginPagePath`).
   */
  loginPage: { method: 'GET', path: '/login', auth: 'public' },
  /**
   * Cookie sign-out (routes.py:496-512): clears the session cookies and
   * answers 302 to /login. Its best-effort revoke depends on the provider: a
   * no-op for basic (stateless tokens) and Nous Portal (no revocation grant),
   * an RFC 7009 revocation of the refresh token for self-hosted OIDC when its
   * IdP advertises a revocation_endpoint (plugins/dashboard_auth/basic/
   * __init__.py:165-167, nous/__init__.py:67-70, self_hosted/__init__.py:
   * 124-145). Either way a copy of the access cookie works until it expires.
   * On the gate's public list (middleware.py:39-42): it reads the cookies it
   * clears.
   */
  logout: { method: 'POST', path: '/auth/logout', auth: 'public' },
} as const

/**
 * Hermes's `is_safe_next_path` (dashboard_auth/request_utils.py:16, 37-44): a
 * same-origin path that is not the login or auth routes and not under /api.
 * Stricter than Hermes: a backslash or a control character is refused too.
 * Browsers read `/\host` as `//host` and drop tabs and newlines, so either
 * would send the browser to another origin after sign-in.
 */
export function isSafeNextPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false
  const unsafe = (char: string) => {
    const code = char.charCodeAt(0)
    return char === '\\' || code < 0x20 || code === 0x7f
  }
  if ([...path].some(unsafe)) return false
  if (['/login', '/auth/', '/api/auth/'].some((p) => path === p || path.startsWith(p)))
    return false
  return !(path === '/api' || path.startsWith('/api/'))
}

/**
 * The login page, returning to `next` (a path and query) after sign-in. Hermes
 * percent-decodes `next` twice before it lands there
 * (`_validate_post_login_target`, routes.py:93-97, at the page and again at
 * `/auth/password-login`, routes.py:171), so each `%` is escaped twice. An
 * unsafe `next` is left out, and Hermes lands on `/`.
 */
export function loginPagePath(next?: string): string {
  const page = restEndpoints.loginPage.path
  if (!next || !isSafeNextPath(next)) return page
  return `${page}?next=${encodeURIComponent(next.replaceAll('%', '%2525'))}`
}

export type RestEndpointName = keyof typeof restEndpoints

/** Single-use WebSocket ticket lifetime advertised by `POST /api/auth/ws-ticket`. */
export const WS_TICKET_TTL_SECONDS = 30

/**
 * JSON-RPC "method not found". Hermes answers it for methods a build lacks,
 * which Cindl reads as version skew. Cindl never sends it as a reply to a
 * server request: that would close the request for every client (rpc.ts).
 */
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

/**
 * Display WebSocket close codes (hermes_cli/web_routers/display.py:37-42).
 * 4001 comes only when the bridge cannot reach the screen as the socket opens
 * (:131-136); a screen that stops mid-view ends the RFB stream and the socket
 * closes with a plain 1000 (:181-185, 241-244). The Host/Origin refusal
 * (4403) happens before accept, so a client sees an HTTP 403 handshake
 * failure, never that code (:80-84).
 */
export const displayCloseCodes = {
  evictedController: 4000,
  /** Only as the socket opens: there is no screen to bridge. */
  screenStopped: 4001,
  ticketRejected: 4401,
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
