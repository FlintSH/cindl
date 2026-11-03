import {
  CindlError,
  clarifyAnswersComplete,
  openQuestionIds,
  RequestId,
  type ApprovalChoice,
  type ClarifyQuestion,
  type ClarifyResponse,
  type RequestAnswer,
  type ServerRequest,
} from '@cindl/contracts'
import { z } from 'zod'
import { boundedText, safeText } from './diagnostics.ts'
import { asCindlError, NotSentError, protocolError } from './errors.ts'
import { parseWire, RequestAnswerResult } from './wire.ts'

/**
 * Server-to-client requests Cindl answers (ADR 0005), shaped as
 * tui_gateway/contracts/server_requests.py at v0.22.5:
 *
 *   approval {session_id, request_id, command, description, choices, allow_session,
 *             allow_permanent, smart_denied, tool_name} -> {choice, all?}
 *   clarify  {session_id, questions[{qid, question, choices?, multi_select}], answers?}
 *            -> {answers: {qid: string | null}}; a result without answers cancels all
 *
 * Cindl answers approvals only with `once` or `deny` and never sends `all`.
 * A clarify set is answered in one reply covering every question no other
 * client has locked: typed text as is, picked options as the option text
 * (single select) or a JSON array string (multi select,
 * tools/clarify_tool.py:36-47), skipped as `null`. Locked questions are left
 * out because Hermes lays the reply over the locks (tools/clarify_batch.py:27-30).
 * Requests are keyed by Hermes's `srq-<12 hex>` id, which survives reconnects.
 *
 * Answers go through `request.answer` (`sendAnswer`), which Hermes
 * acknowledges, never as a bare response frame, which it does not.
 */

const PERMITTED: readonly ApprovalChoice[] = ['once', 'deny']

const ApprovalParams = z.object({
  session_id: z.string().min(1),
  request_id: z.string().min(1),
  command: z.string().optional(),
  description: z.string().optional(),
  choices: z.array(z.string()).optional(),
  allow_session: z.boolean().nullable().optional(),
  allow_permanent: z.boolean().nullable().optional(),
  smart_denied: z.boolean().nullable().optional(),
  tool_name: z.string().nullable().optional(),
})

const ClarifyParams = z.object({
  session_id: z.string().min(1),
  /** Answers other clients locked with clarify.lock; only on a reconnect snapshot. */
  answers: z.record(z.string(), z.string().nullable()).nullable().optional(),
  questions: z
    .array(
      z.object({
        qid: z.string().min(1),
        question: z.string(),
        choices: z.array(z.string()).nullable().optional(),
        multi_select: z.boolean().optional(),
      }),
    )
    .min(1),
})

export interface InboundRequestInput {
  /** Hermes's JSON-RPC id for the request (`srq-…`). */
  requestId: string
  method: string
  params: Record<string, unknown>
  /** Connection epoch the request was (re)delivered on; diagnostics only. */
  lastSeenEpoch: number
  receivedAt: string
  /** The conversation (stored session) `params.session_id` belongs to. */
  conversationId: string
}

export interface MappedRequest {
  request: ServerRequest
  /** Runtime session id the request blocks (`params.session_id`). */
  runtimeSessionId: string
}

/** Hermes's own default when `choices` is absent (tui_gateway/server.py:781-790). */
function defaultChoices(params: z.infer<typeof ApprovalParams>): string[] {
  const choices = ['once']
  if (!params.smart_denied && params.allow_session !== false) {
    choices.push('session')
    if (params.allow_permanent !== false) choices.push('always')
  }
  return [...choices, 'deny']
}

/** A locked raw answer as the contract's per-question response. */
function lockedResponse(
  question: ClarifyQuestion | undefined,
  raw: string | null,
): ClarifyResponse {
  const value = raw?.trim() ?? ''
  if (!value) return { skipped: true }
  if (question?.multiSelect) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((item) => typeof item === 'string')
      )
        return { choices: parsed }
    } catch {
      // A typed "Other" answer to a multi-select question.
    }
  }
  if (question?.choices?.includes(value)) return { choices: [value] }
  return { text: value.slice(0, 20_000) }
}

export function mapServerRequest(input: InboundRequestInput): MappedRequest | undefined {
  // Hermes mints `srq-<12 hex>` (server_requests.py:71); anything else is not one of its requests.
  if (!RequestId.safeParse(input.requestId).success) return undefined
  const base = {
    requestId: input.requestId,
    lastSeenEpoch: input.lastSeenEpoch,
    receivedAt: input.receivedAt,
    status: 'open' as const,
    conversationId: input.conversationId,
  }
  if (input.method === 'approval') {
    const parsed = ApprovalParams.safeParse(input.params)
    if (!parsed.success) return undefined
    const params = parsed.data
    const offered = params.choices ?? defaultChoices(params)
    const choices = PERMITTED.filter((choice) => offered.includes(choice))
    const withheld = offered.filter((choice) => !(PERMITTED as string[]).includes(choice))
    const request: ServerRequest = {
      ...base,
      kind: 'approval',
      hermesApprovalId: params.request_id,
      title: params.tool_name
        ? `${safeText(params.tool_name, 80)} needs your approval`
        : 'Hermes needs your approval',
      choices,
      ...(withheld.length ? { withheldChoices: withheld } : {}),
      ...(params.command === undefined
        ? {}
        : { command: boundedText(params.command, 4_000) }),
      ...(params.description
        ? { description: boundedText(params.description, 1_000) }
        : {}),
      ...(params.tool_name ? { toolName: safeText(params.tool_name, 80) } : {}),
    }
    return { request, runtimeSessionId: params.session_id }
  }
  if (input.method === 'clarify') {
    const parsed = ClarifyParams.safeParse(input.params)
    if (!parsed.success) return undefined
    const questions: ClarifyQuestion[] = parsed.data.questions.map((question) => ({
      qid: question.qid,
      question: question.question,
      ...(question.choices?.length ? { choices: question.choices } : {}),
      multiSelect: question.multi_select === true && Boolean(question.choices?.length),
    }))
    // Answers other clients locked (ServerRequest.snapshot, server_requests.py:93-99).
    const locked = Object.entries(parsed.data.answers ?? {}).flatMap(([qid, raw]) => {
      const question = questions.find((q) => q.qid === qid)
      return question ? [[qid, lockedResponse(question, raw)] as const] : []
    })
    const request: ServerRequest = {
      ...base,
      kind: 'clarify',
      title:
        questions.length === 1
          ? 'Hermes has a question'
          : `Hermes has ${questions.length} questions`,
      choices: [],
      questions,
      ...(locked.length ? { lockedAnswers: Object.fromEntries(locked) } : {}),
    }
    return { request, runtimeSessionId: parsed.data.session_id }
  }
  return undefined
}

/**
 * The JSON-RPC `result` that answers `request` with `answer`, or a CindlError
 * when the answer does not fit what Hermes offered. Never produces `all`.
 */
export function answerResult(
  request: ServerRequest,
  answer: RequestAnswer,
): Record<string, unknown> {
  if (request.kind === 'approval') {
    if (answer.kind !== 'approval')
      throw new CindlError('invalid', 'This request expects an approval decision.')
    if (!request.choices.includes(answer.choice))
      throw new CindlError(
        'invalid',
        'That choice was not offered for this request.',
        `choice ${answer.choice} not in [${request.choices.join(', ')}]`,
      )
    return { choice: answer.choice }
  }
  if (answer.kind === 'clarify-cancel') return {}
  if (answer.kind !== 'clarify')
    throw new CindlError('invalid', 'This request expects answers to its questions.')
  if (!clarifyAnswersComplete(request, answer.answers))
    throw new CindlError(
      'invalid',
      'Answer or skip every open question, then send them together.',
    )
  const open = new Set(openQuestionIds(request))
  const answers: Record<string, string | null> = {}
  for (const question of request.questions ?? []) {
    // A question another client locked is not ours to answer: the reply would override it.
    if (!open.has(question.qid)) continue
    const response = answer.answers[question.qid]
    if (!response || 'skipped' in response) {
      answers[question.qid] = null
      continue
    }
    if ('text' in response) {
      answers[question.qid] = response.text
      continue
    }
    const offered = question.choices ?? []
    if (!response.choices.every((choice) => offered.includes(choice)))
      throw new CindlError('invalid', 'Pick from the options Hermes offered.')
    if (question.multiSelect) answers[question.qid] = JSON.stringify(response.choices)
    else if (response.choices.length === 1)
      answers[question.qid] = response.choices[0] ?? null
    else throw new CindlError('invalid', 'That question takes a single answer.')
  }
  return { answers }
}

/** How one answer ended. Exactly one per `sendAnswer` call. */
export type AnswerOutcome =
  /**
   * Hermes's request registry took the answer (`request.answer` → `ok`). It
   * says nothing about whether a command or tool then succeeded.
   */
  | { kind: 'answered' }
  /** Hermes no longer waited for it (`expired`): answered elsewhere, withdrawn or timed out. */
  | { kind: 'no-longer-pending' }
  /**
   * The answer did not reach Hermes, Hermes refused it (the request is still
   * open), or no acknowledgement came back. `delivered` is false only when
   * nothing left this device. Re-sending is safe either way: the first answer
   * wins and a later one gets `expired` (server_requests.py:281-317).
   */
  | { kind: 'failed'; delivered: boolean; error: CindlError }

/**
 * Answer an open server request through `request.answer {id, result}`, the
 * acknowledged path on the sidecar (tui_gateway/methods_prompt.py:1289-1302):
 * Hermes settles it like a response frame (`resolve_response`) and replies
 * `ok`, or `expired` when nothing waits for that id anymore. A bare response
 * frame gets no reply at all, so it cannot tell the two apart.
 */
export async function sendAnswer(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  requestId: string,
  result: Record<string, unknown>,
): Promise<AnswerOutcome> {
  let raw: unknown
  try {
    raw = await rpc('request.answer', { id: requestId, result })
  } catch (error) {
    return {
      kind: 'failed',
      delivered: !(error instanceof NotSentError),
      error: asCindlError(error, 'request.answer'),
    }
  }
  const parsed = parseWire(RequestAnswerResult, raw)
  if (!parsed)
    return {
      kind: 'failed',
      delivered: true,
      error: protocolError('request.answer: unexpected result'),
    }
  return parsed.status === 'ok' ? { kind: 'answered' } : { kind: 'no-longer-pending' }
}
