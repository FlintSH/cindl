/**
 * Redaction for anything that can leave memory as text: diagnostics, logs,
 * error details, copied reports. Conversation content is not "redacted" here;
 * it is simply never logged. These rules catch credentials that slip into
 * strings (URLs, headers, tool output previews).
 */

const MARK = '[redacted]'

const SENSITIVE_KEY =
  /^(?:access_?token|refresh_?token|id_?token|token|ticket|code|code_?verifier|password|passphrase|secret|client_?secret|api_?key|apikey|authorization|cookie|set-cookie|otp|totp|mfa_?code|session_?id_?cookie|private_?key)$/i

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // WebSocket ticket subprotocol and ticket query parameters.
  [/hermes-gateway-ticket\.[^\s,'"]+/g, `hermes-gateway-ticket.${MARK}`],
  [
    /([?&](?:ticket|code|code_verifier|access_token|refresh_token|token|state)=)[^&#\s'"]+/gi,
    `$1${MARK}`,
  ],
  // Authorization headers.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MARK}`],
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
  // key=value / "key": "value" pairs with a sensitive key name.
  [
    /(["']?(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
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
      out[key] = SENSITIVE_KEY.test(key) ? MARK : redactValue(entry, depth + 1)
    return out
  }
  return value
}

/** Strip query values and userinfo from a URL for display. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, MARK)
    return url.toString().replace(/%5Bredacted%5D/g, MARK)
  } catch {
    return redactText(raw)
  }
}
