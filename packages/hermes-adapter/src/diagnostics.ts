import { redactText, redactValue } from './redact.ts'

/**
 * Diagnostics are the only text the adapter produces for logs. Every entry
 * passes through `redactValue` before it reaches the sink, so tickets,
 * `hermes-gateway-ticket.*` subprotocols, tokens, codes and verifiers never
 * leave memory in clear text. Conversation content is never logged at all:
 * callers pass method names, status codes and ids, not payloads.
 */
export interface DiagnosticEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  detail?: Record<string, unknown>
}

export type DiagnosticSink = (entry: DiagnosticEntry) => void

export interface Diagnostics {
  log(
    level: DiagnosticEntry['level'],
    event: string,
    detail?: Record<string, unknown>,
  ): void
}

export const silentDiagnostics: Diagnostics = { log: () => undefined }

export function createDiagnostics(sink: DiagnosticSink | undefined): Diagnostics {
  if (!sink) return silentDiagnostics
  return {
    log(level, event, detail) {
      try {
        sink(
          detail === undefined
            ? { level, event: redactText(event) }
            : {
                level,
                event: redactText(event),
                detail: redactValue(detail) as Record<string, unknown>,
              },
        )
      } catch {
        // A failing log sink must never break the connection it describes.
      }
    },
  }
}

/** Bounded, redacted text for error details and previews. */
export function safeText(value: unknown, max = 240): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : value === undefined || value === null
          ? ''
          : (JSON.stringify(value) ?? '')
  const redacted = redactText(text.replace(/\s+/g, ' ').trim())
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}

/** Redacted and truncated, but with line breaks kept (commands, previews). */
export function boundedText(value: string, max: number): string {
  const redacted = redactText(value)
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}
