import {
  assertAnswerable,
  clarifyAnswersComplete,
  openQuestionIds,
  type CindlClientApi,
  type ClarifyQuestion,
  type ClarifyResponse,
  type OpArgs,
  type RequestAnswer,
  type ServerRequest,
  type UnsupportedRequestKind,
} from '@cindl/contracts'

/**
 * Request identity, clarify drafts and answers (web parity:
 * apps/web/src/talk/RequestCard.tsx). Requests are keyed by Hermes's request
 * id, which is stable across reconnects, never by connection.
 */
export function requestKeyOf(request: Pick<ServerRequest, 'requestId'>): string {
  return request.requestId
}

export function answerArgs(
  request: Pick<ServerRequest, 'requestId'>,
  answer: RequestAnswer,
): OpArgs<'request.answer'> {
  return { requestId: request.requestId, answer }
}

/**
 * The one way the app answers a request. A prompt Cindl never answers (sudo,
 * secret, vault, unknown) is refused here, before anything is sent: any
 * reply, even a decline, can become the password Hermes uses (ADR 0005).
 */
export async function sendAnswer(
  api: Pick<CindlClientApi, 'call'>,
  request: ServerRequest,
  answer: RequestAnswer,
): Promise<ServerRequest> {
  assertAnswerable(request)
  return api.call('request.answer', answerArgs(request, answer))
}

/**
 * One answer at a time from a card: a second tap while an answer is on its
 * way sends nothing. The lock covers the call only. While Hermes acknowledges,
 * the shared reducer says `answering`; if the answer then fails, it reopens
 * the request and the card must be usable again (there is no terminal
 * failure). Resolves false when nothing was sent.
 */
export async function answerOnce(
  lock: { current: boolean },
  request: Pick<ServerRequest, 'status'>,
  send: () => Promise<void>,
): Promise<boolean> {
  if (lock.current || request.status === 'answering') return false
  lock.current = true
  try {
    await send()
    return true
  } finally {
    lock.current = false
  }
}

/** How the working margin and TalkBack name a request. */
export function requestNoun(request: Pick<ServerRequest, 'kind'>): string {
  if (request.kind === 'approval') return 'approval'
  if (request.kind === 'clarify') return 'question'
  return 'prompt to answer outside Cindl'
}

const asks: Record<UnsupportedRequestKind, string> = {
  sudo: 'a sudo password',
  secret: 'a secret value',
  vault: 'a vault password or code',
  other: 'an answer Cindl cannot send',
}

/**
 * The read-only card for a prompt Cindl never answers (web parity): what
 * Hermes waits for and where to answer it. Nothing is offered to send, so the
 * prompt stays open for another Hermes surface; that holds for app-level
 * prompts (no conversation) too.
 */
export function unsupportedCopy(request: Pick<ServerRequest, 'unsupportedKind'>): string {
  const kind = request.unsupportedKind ?? 'other'
  const refusal =
    kind === 'other'
      ? 'Cindl does not support this kind of prompt and sends nothing for it.'
      : 'Cindl never collects passwords, secrets or codes and sends nothing for this prompt.'
  return `Hermes is waiting for ${asks[kind]}. ${refusal} Answer it in another Hermes surface, such as the Hermes terminal. It stays open here until Hermes closes it.`
}

/**
 * One question's draft. Nothing the owner typed or picked is discarded by
 * another control: choosing an option keeps the typed text, and skipping
 * keeps both until the owner sends.
 */
export interface QuestionDraft {
  selected: readonly string[]
  other: string
  /** Single choice only: the owner chose "Other" (their typed answer). */
  useOther: boolean
  skipped: boolean
}

export const emptyDraft: QuestionDraft = {
  selected: [],
  other: '',
  useOther: false,
  skipped: false,
}

export type ClarifyDrafts = Readonly<Record<string, QuestionDraft>>

/** A question's draft. Question ids come from Hermes, so only own properties count. */
export function draftFor(drafts: ClarifyDrafts, qid: string): QuestionDraft {
  return Object.hasOwn(drafts, qid) ? (drafts[qid] ?? emptyDraft) : emptyDraft
}

export function withDraft(
  drafts: ClarifyDrafts,
  qid: string,
  draft: QuestionDraft,
): ClarifyDrafts {
  // A computed key defines an own property, even for `__proto__`.
  return { ...drafts, [qid]: draft }
}

const hasChoices = (question: ClarifyQuestion) => (question.choices?.length ?? 0) > 0

/** Picking replaces a single choice and toggles a multi-select one; typed text stays. */
export function pickChoice(
  question: ClarifyQuestion,
  draft: QuestionDraft,
  choice: string,
): QuestionDraft {
  return {
    ...draft,
    useOther: false,
    selected: question.multiSelect
      ? draft.selected.includes(choice)
        ? draft.selected.filter((value) => value !== choice)
        : [...draft.selected, choice]
      : [choice],
  }
}

/** Single choice: answer with the typed text instead of an offered option. */
export function chooseOther(draft: QuestionDraft): QuestionDraft {
  return { ...draft, useOther: true }
}

/** Typing into a single-choice question selects "Other"; picks are kept. */
export function typeAnswer(
  question: ClarifyQuestion,
  draft: QuestionDraft,
  other: string,
): QuestionDraft {
  const single = !question.multiSelect && hasChoices(question)
  return { ...draft, other, useOther: single ? true : draft.useOther }
}

export function setSkipped(draft: QuestionDraft, skipped: boolean): QuestionDraft {
  return { ...draft, skipped }
}

/** The reply for one question, or undefined while it is unanswered. */
export function responseFor(
  question: ClarifyQuestion,
  draft: QuestionDraft,
): ClarifyResponse | undefined {
  if (draft.skipped) return { skipped: true }
  const typed = draft.other.trim()
  if (!hasChoices(question)) return typed ? { text: typed } : undefined
  if (!question.multiSelect) {
    if (draft.useOther) return typed ? { text: typed } : undefined
    return draft.selected[0] ? { choices: [draft.selected[0]] } : undefined
  }
  if (!draft.selected.length) return typed ? { text: typed } : undefined
  return { choices: typed ? [...draft.selected, typed] : [...draft.selected] }
}

/** How a locked answer from another device reads in the card. */
export function describeResponse(response: ClarifyResponse | undefined): string {
  if (!response) return 'unknown'
  if ('skipped' in response) return 'skipped'
  if ('text' in response) return response.text
  return response.choices.join(', ')
}

/** Questions Cindl may answer, and those another client already locked (shown, never overridden). */
export function splitQuestions(
  request: Pick<ServerRequest, 'questions' | 'lockedAnswers'>,
) {
  const open = new Set(openQuestionIds(request))
  const locked = request.lockedAnswers ?? {}
  const questions = request.questions ?? []
  return {
    open: questions.filter((question) => open.has(question.qid)),
    locked: questions
      .filter((question) => !open.has(question.qid))
      .map((question) => ({
        question,
        response: Object.hasOwn(locked, question.qid) ? locked[question.qid] : undefined,
      })),
  }
}

/** One tap answers only a single open single-choice question (the tap is the whole reply). */
export function isQuickQuestion(open: readonly ClarifyQuestion[]): boolean {
  const [only] = open
  return open.length === 1 && !!only && !only.multiSelect && hasChoices(only)
}

/** Replies for the open questions that have one. */
export function clarifyResponses(
  open: readonly ClarifyQuestion[],
  drafts: ClarifyDrafts,
): Record<string, ClarifyResponse> {
  return Object.fromEntries(
    open.flatMap((question) => {
      const response = responseFor(question, draftFor(drafts, question.qid))
      return response ? [[question.qid, response] as const] : []
    }),
  )
}

/** One reply for the set: every open question answered or skipped, no locked one. */
export function buildClarifyAnswer(
  request: Pick<ServerRequest, 'questions' | 'lockedAnswers'>,
  drafts: ClarifyDrafts,
): RequestAnswer | undefined {
  const answers = clarifyResponses(splitQuestions(request).open, drafts)
  return clarifyAnswersComplete(request, answers)
    ? { kind: 'clarify', answers }
    : undefined
}

/**
 * "Skip all": one reply that skips every open question. There is no decline:
 * an empty reply reaches the agent like an interrupt, while a skip gives each
 * question a clean "skipped" (contract v4, tools/clarify_batch.py at v0.22.5).
 * Questions another device locked are left out, as in every reply.
 */
export function skipAllAnswer(
  request: Pick<ServerRequest, 'questions' | 'lockedAnswers'>,
): RequestAnswer {
  return {
    kind: 'clarify',
    answers: Object.fromEntries(
      splitQuestions(request).open.map((question) => [
        question.qid,
        { skipped: true as const },
      ]),
    ),
  }
}

const draftsByRequest = new Map<string, ClarifyDrafts>()

/** Drafts survive remounts (switching views, a re-sent request) for this session. */
export const clarifyDraftStore = {
  load: (requestId: string): ClarifyDrafts => draftsByRequest.get(requestId) ?? {},
  save: (requestId: string, drafts: ClarifyDrafts) => {
    draftsByRequest.set(requestId, drafts)
  },
}
