/**
 * Redaction for anything that can leave memory as text: diagnostics, logs,
 * error details, copied reports. Conversation content is not "redacted" here;
 * it is simply never logged. These rules catch credentials that slip into
 * strings (URLs, headers, JSON bodies, tool output previews).
 */

const MARK = '[redacted]'

/**
 * Keys whose values are credentials or capabilities. `code` is masked only
 * when it holds a string (an OAuth code); numeric JSON-RPC and HTTP codes stay
 * visible. `viewer_id` is a display-lease capability (tools/bot_desktop/lease.py).
 */
const SENSITIVE_KEY =
  /^(?:access_?token|refresh_?token|id_?token|token|session_?token|x[-_]hermes[-_]session[-_]token|ticket|ws_?ticket|display_?ticket|code_?verifier|password|passphrase|secret|client_?secret|api_?key|apikey|x[-_]api[-_]key|authorization|proxy[-_]authorization|cookie|set[-_]cookie|otp|totp|mfa_?code|session_?id_?cookie|private_?key|viewer_?id)$/i
const STRING_ONLY_KEY = /^code$/i

const SECRET_NAMES =
  'password|passphrase|secret|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|token|ticket|ws[_-]?ticket|display[_-]?ticket|code[_-]?verifier|viewer[_-]?id|(?:proxy-)?authorization|(?:set-)?cookie'

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // WebSocket ticket subprotocol and credential query parameters.
  [/hermes-gateway-ticket\.[^\s,'"]+/g, `hermes-gateway-ticket.${MARK}`],
  [
    /([?&](?:ticket|display_ticket|code|code_verifier|access_token|refresh_token|token|state|id_token)=)[^&#\s'"]+/gi,
    `$1${MARK}`,
  ],
  // Whole Cookie / Set-Cookie header values.
  [/(\b(?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${MARK}`],
  // Hermes session cookies wherever they appear (dashboard_auth/cookies.py).
  [/((?:__Host-|__Secure-)?hermes_session_[a-z]+=)[^;\s,'"]+/gi, `$1${MARK}`],
  // Authorization headers, any case.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARK}`],
  // PEM private keys.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MARK],
  // JWT-shaped tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, MARK],
  // Common provider key formats.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, MARK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, MARK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, MARK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MARK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MARK],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, MARK],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, MARK],
  // "code": "…" only when the value is a string (OAuth code); numeric codes stay.
  [/("code"\s*:\s*")[^"]*(")/gi, `$1${MARK}$2`],
  // key=value / "key": "value" pairs with a sensitive key name.
  [
    new RegExp(`(["']?\\b(?:${SECRET_NAMES})["']?\\s*[:=]\\s*["']?)[^"'\\s,;}&]+`, 'gi'),
    `$1${MARK}`,
  ],
  // URL userinfo.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${MARK}@`],
]

export function redactText(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Deep copy with sensitive keys masked and every string passed through redactText. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return MARK
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value))
      out[key] =
        SENSITIVE_KEY.test(key) ||
        (STRING_ONLY_KEY.test(key) && typeof entry === 'string')
          ? MARK
          : redactValue(entry, depth + 1)
    return out
  }
  return value
}

/** Strip query values, fragments and userinfo from a URL for display. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, MARK)
    return url.toString().replace(/%5Bredacted%5D/g, MARK)
  } catch {
    return redactText(raw.replace(/#.*$/, ''))
  }
}
