import {
  clarifyAnswersComplete,
  openQuestionIds,
  type ClarifyQuestion,
  type ClarifyResponse,
  type OpArgs,
  type RequestAnswer,
  type ServerRequest,
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

const draftsByRequest = new Map<string, ClarifyDrafts>()

/** Drafts survive remounts (switching views, a re-sent request) for this session. */
export const clarifyDraftStore = {
  load: (requestId: string): ClarifyDrafts => draftsByRequest.get(requestId) ?? {},
  save: (requestId: string, drafts: ClarifyDrafts) => {
    draftsByRequest.set(requestId, drafts)
  },
}
