import { z } from 'zod'

/** Stable error codes surfaced to every client. User copy lives in the handbook. */
export const errorCodes = [
  'unauthenticated',
  'forbidden',
  'unsupported',
  'unavailable',
  'conflict',
  'invalid',
  'not-found',
  'timeout',
  'offline',
  'uncertain',
  'protocol',
  'internal',
] as const
export const ErrorCode = z.enum(errorCodes)
export type ErrorCode = z.infer<typeof ErrorCode>

export const CindlErrorShape = z.object({
  code: ErrorCode,
  message: z.string(),
  /** Safe, redacted context for diagnostics. Never contains secrets or content. */
  detail: z.string().optional(),
})
export type CindlErrorShape = z.infer<typeof CindlErrorShape>

export class CindlError extends Error {
  readonly code: ErrorCode
  readonly detail: string | undefined
  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'CindlError'
    this.code = code
    this.detail = detail
  }
  toJSON(): CindlErrorShape {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail }
  }
}

export function isCindlError(value: unknown): value is CindlError {
  return value instanceof CindlError
}
