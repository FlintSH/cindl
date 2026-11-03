import { redactText, redactValue } from '@cindl/hermes-adapter'

/**
 * Main-process logging. Every line is passed through the adapter's redaction
 * (tokens, tickets, codes, verifiers, credentials in URLs) before it is
 * written, so a log or a pasted diagnostic never carries a secret. Message
 * content is not logged at all; callers pass short descriptions and errors.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Property signatures: every member is safe to pass around unbound. */
export interface Logger {
  debug: (message: string, detail?: unknown) => void
  info: (message: string, detail?: unknown) => void
  warn: (message: string, detail?: unknown) => void
  error: (message: string, detail?: unknown) => void
}

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function parseLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'
}

/**
 * Header lines in free text that the adapter's `redactText` does not mask
 * yet (cookies; Authorization with any scheme). Applied after it. Remove once
 * @cindl/hermes-adapter covers these forms itself.
 */
const HEADER_LINE =
  /\b((?:proxy-)?authorization|set-cookie|cookie)(["']?\s*[:=]\s*)[^\r\n,}]+/gi
const redactHeaders = (text: string) => text.replace(HEADER_LINE, '$1$2[redacted]')

function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactHeaders(value)
  if (Array.isArray(value)) return value.map(redactStrings)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactStrings(entry)]),
    )
  return value
}

/**
 * Errors keep their name, message and code (as `errorCode`: redaction masks
 * any `code` key, which is how OAuth codes travel); other values are copied.
 */
function describe(detail: unknown): unknown {
  if (detail instanceof Error) {
    const code = (detail as { code?: unknown }).code
    return {
      name: detail.name,
      message: detail.message,
      ...(typeof code === 'string' || typeof code === 'number'
        ? { errorCode: code }
        : {}),
    }
  }
  return detail
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}

/** One log line, already redacted. Exported for tests. */
export function formatLogLine(
  level: LogLevel,
  message: string,
  detail: unknown,
  now: Date,
): string {
  const parts = [
    now.toISOString(),
    level.toUpperCase(),
    redactHeaders(redactText(message)),
  ]
  if (detail !== undefined)
    parts.push(serialize(redactStrings(redactValue(describe(detail)))))
  return parts.join(' ')
}

export function createLogger(
  options: {
    level?: LogLevel
    write?: (line: string) => void
    now?: () => Date
  } = {},
): Logger {
  const threshold = rank[options.level ?? 'info']
  const write =
    options.write ?? ((line: string) => void process.stderr.write(`${line}\n`))
  const now = options.now ?? (() => new Date())
  const at =
    (level: LogLevel) =>
    (message: string, detail?: unknown): void => {
      if (rank[level] < threshold) return
      write(formatLogLine(level, message, detail, now()))
    }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}
