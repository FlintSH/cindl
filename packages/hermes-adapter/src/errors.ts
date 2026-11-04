import { CindlError, type ErrorCode } from '@cindl/contracts'
import { safeText } from './diagnostics.ts'

/**
 * Error mapping from Hermes v0.22.5 to Cindl's stable codes. Messages are
 * user-facing and generic; `detail` carries a redacted, bounded hint for
 * diagnostics. Neither ever contains a token, ticket, code or verifier.
 */

/** JSON-RPC codes used by tui_gateway at v0.22.5 (server.py `_err`, contracts/registry.py). */
export const rpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Unknown params key: client and backend are on different contract versions. */
  paramsOutOfSync: 4000,
  sessionNotFound: 4001,
  storedSessionNotFound: 4007,
} as const

/**
 * Hermes's raw error text, kept off the serialised error: it can contain host
 * paths (e.g. `Could not write SOUL.md: <OSError>`). Adapter code may classify
 * it; it never reaches `detail`, logs or IPC.
 */
const hermesReasons = new WeakMap<CindlError, string>()

export function hermesReasonOf(error: unknown): string {
  return error instanceof CindlError ? (hermesReasons.get(error) ?? '') : ''
}

/** Short machine tokens such as `revision_conflict` are safe to show; prose is not. */
const SAFE_TOKEN = /^[a-z][a-z0-9_]{2,40}$/

function withReason(error: CindlError, reason: string): CindlError {
  if (reason) hermesReasons.set(error, reason)
  return error
}

const httpCodes: ReadonlyArray<[number, ErrorCode, string]> = [
  [400, 'invalid', 'Hermes rejected the request.'],
  [401, 'unauthenticated', 'Sign in to Hermes again.'],
  [403, 'forbidden', 'Hermes refused this request.'],
  [404, 'not-found', 'Hermes could not find that.'],
  [409, 'conflict', 'Hermes reported a conflicting change.'],
  [413, 'invalid', 'That is larger than Hermes accepts.'],
  [422, 'protocol', 'Hermes did not understand the request (version mismatch?).'],
  [429, 'unavailable', 'Hermes is rate limiting requests. Try again shortly.'],
]

/**
 * The errors that report Hermes did not answer (no network, a timeout, a 5xx
 * while it restarts, rate limiting), by identity: a code alone cannot tell
 * them from a failure on the device, which asCindlError also calls internal.
 */
const unanswered = new WeakSet<CindlError>()

function noAnswer(error: CindlError): CindlError {
  unanswered.add(error)
  return error
}

/**
 * Whether `error` is the adapter's report that Hermes did not answer, so
 * asking again later may help. Its answers (a 4xx, a reply in an unexpected
 * shape) and failures on this device (its secret store, an exception) are
 * not, whatever their code.
 */
export function hermesDidNotAnswer(error: unknown): boolean {
  return error instanceof CindlError && unanswered.has(error)
}

export function httpError(status: number, body: unknown, context: string): CindlError {
  const reason = bodyReason(body)
  const shown = SAFE_TOKEN.test(reason) ? ` (${reason})` : ''
  const detail = safeText(`${context}: HTTP ${status}${shown}`)
  const error = withReason(httpErrorFor(status, detail), reason)
  return status >= 500 || status === 429 ? noAnswer(error) : error
}

function httpErrorFor(status: number, detail: string): CindlError {
  const known = httpCodes.find(([code]) => code === status)
  if (known) return new CindlError(known[1], known[2], detail)
  if (status === 502 || status === 503 || status === 504)
    return new CindlError('unavailable', 'Hermes is unavailable right now.', detail)
  if (status >= 500)
    return new CindlError('internal', 'Hermes reported an error.', detail)
  return new CindlError('protocol', 'Hermes answered unexpectedly.', detail)
}

/** True when a 401 body is Hermes's structured session rejection (middleware.py `_unauth_response`). */
export function isSessionRejection(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const error = (body as { error?: unknown }).error
  return error === 'unauthenticated' || error === 'session_expired'
}

function bodyReason(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const record = body as Record<string, unknown>
  for (const key of ['error', 'reason', 'detail']) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

export interface RpcErrorPayload {
  code?: unknown
  message?: unknown
  data?: unknown
}

export function rpcError(error: RpcErrorPayload | undefined, method: string): CindlError {
  const code = typeof error?.code === 'number' ? error.code : undefined
  const message = typeof error?.message === 'string' ? error.message : ''
  const detail = safeText(
    `${method}: ${code ?? 'no code'}${SAFE_TOKEN.test(message) ? ` ${message}` : ''}`,
  )
  return withReason(rpcErrorFor(code, detail), message)
}

function rpcErrorFor(code: number | undefined, detail: string): CindlError {
  switch (code) {
    case rpcErrorCodes.methodNotFound:
      return new CindlError(
        'unsupported',
        'This Hermes version does not offer that operation.',
        detail,
      )
    case rpcErrorCodes.paramsOutOfSync:
      return new CindlError(
        'protocol',
        'Cindl and this Hermes version disagree about the request format.',
        detail,
      )
    case rpcErrorCodes.parseError:
    case rpcErrorCodes.invalidRequest:
      return new CindlError('protocol', 'Hermes could not read the request.', detail)
    case rpcErrorCodes.invalidParams:
      return new CindlError('invalid', 'Hermes rejected the request.', detail)
    case rpcErrorCodes.internal:
      return new CindlError('internal', 'Hermes reported an error.', detail)
    case rpcErrorCodes.sessionNotFound:
    case rpcErrorCodes.storedSessionNotFound:
      return new CindlError(
        'not-found',
        'Hermes no longer has that conversation.',
        detail,
      )
    default:
      if (code !== undefined && code >= 4000 && code < 5000)
        return new CindlError('invalid', 'Hermes rejected the request.', detail)
      if (code !== undefined && code >= 5000 && code < 6000)
        return new CindlError(
          'unavailable',
          'Hermes could not complete that now.',
          detail,
        )
      return new CindlError('internal', 'Hermes reported an error.', detail)
  }
}

/**
 * The request never left this device (the socket was not open). Unlike a
 * timeout or a drop after sending, Hermes cannot have acted on it.
 */
export class NotSentError extends CindlError {
  constructor(detail: string) {
    super('offline', 'Not connected to Hermes.', safeText(detail))
    this.name = 'NotSentError'
  }
}

export function offlineError(detail: string): CindlError {
  return noAnswer(new CindlError('offline', 'Not connected to Hermes.', safeText(detail)))
}

export function timeoutError(detail: string): CindlError {
  return noAnswer(
    new CindlError('timeout', 'Hermes did not answer in time.', safeText(detail)),
  )
}

export function protocolError(detail: string): CindlError {
  return new CindlError(
    'protocol',
    'Hermes answered in an unexpected format.',
    safeText(detail),
  )
}

/** Normalize anything thrown into a CindlError without leaking its raw text. */
export function asCindlError(error: unknown, fallbackDetail: string): CindlError {
  if (error instanceof CindlError) return error
  const detail = safeText(
    `${fallbackDetail}: ${error instanceof Error ? error.message : String(error)}`,
  )
  return new CindlError('internal', 'Something went wrong talking to Hermes.', detail)
}
