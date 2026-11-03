import { isCindlError, type ErrorCode } from '@cindl/contracts'

/**
 * Wording for failed operations that never overstates certainty. Only error
 * codes that mean "rejected before Hermes acted" allow saying it was not
 * sent, saved or changed; anything else (timeouts, uncertain submissions,
 * protocol or unknown errors) might have reached Hermes, and the copy says
 * so instead of inviting a repeat. Code sets match the web client.
 */
export interface FailureCopy {
  /** True only when the operation certainly did not take effect. */
  certain: boolean
  message: string
}

export function describeFailure(
  error: unknown,
  uncertainMessage: string,
  certainCodes: ReadonlySet<ErrorCode> = NOT_APPLIED,
): FailureCopy {
  if (isCindlError(error) && certainCodes.has(error.code))
    return { certain: true, message: error.message }
  return { certain: false, message: uncertainMessage }
}

/** Rejected before anything reached Hermes. */
export const NOT_APPLIED: ReadonlySet<ErrorCode> = new Set([
  'invalid',
  'offline',
  'unsupported',
  'unavailable',
  'unauthenticated',
])

/** A request answer Hermes or the client refused (already closed, not offered, gone). */
export const ANSWER_REFUSED: ReadonlySet<ErrorCode> = new Set([
  'conflict',
  'invalid',
  'not-found',
])

export const SEND_UNCERTAIN =
  'Cindl could not confirm whether this message was sent. Check the conversation before sending it again.'
export const ANSWER_UNCERTAIN =
  'Cindl could not confirm your answer. Hermes may have received it; check before answering again.'
export const SAVE_UNCERTAIN =
  'Cindl could not confirm the save. Reload to check the current version before editing again.'
export const ROUTINE_UNCERTAIN =
  'Cindl could not confirm whether the routine changed. Reload Work to check.'
export const CONTROL_UNCERTAIN =
  'Cindl could not confirm the change. Check the screen state before trying again.'
