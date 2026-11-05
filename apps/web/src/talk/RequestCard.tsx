import { useCindlApi } from '@cindl/client-react'
import {
  clarifyAnswersComplete,
  isCindlError,
  type ClarifyQuestion,
  type ClarifyResponse,
  type RequestAnswer,
  type ServerRequest,
  type UnsupportedRequestKind,
} from '@cindl/contracts'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  HelpCircle,
  KeyRound,
  ShieldAlert,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './talk.module.css'

export const requestDomId = (request: Pick<ServerRequest, 'requestId'>) =>
  `request-${request.requestId.replace(/[^A-Za-z0-9_-]/g, '_')}`

/** Unknown failures may still have reached Hermes; never claim nothing happened. */
const uncertain =
  'Cindl could not confirm your answer. Hermes may have received it; check before answering again.'

/**
 * Per-question draft. Nothing the owner typed or picked is discarded by
 * another control: choosing an option keeps the typed text, and skipping keeps
 * both until the owner sends.
 */
type Draft = { selected: string[]; other: string; useOther: boolean; skipped: boolean }
const emptyDraft: Draft = { selected: [], other: '', useOther: false, skipped: false }

/** Drafts survive remounts (switching views, re-sent requests) while a request is open. */
const draftsByRequest = new Map<string, Record<string, Draft>>()

/** Docked question sets the owner folded away, so a remount keeps them folded. */
const foldedRequests = new Set<string>()

/** Drop drafts of requests that are no longer open (all of them when `open` is empty). */
export function pruneRequestDrafts(open: ReadonlySet<string>) {
  for (const requestId of draftsByRequest.keys())
    if (!open.has(requestId)) draftsByRequest.delete(requestId)
  for (const requestId of foldedRequests)
    if (!open.has(requestId)) foldedRequests.delete(requestId)
}

function responseFor(
  question: ClarifyQuestion,
  draft: Draft,
): ClarifyResponse | undefined {
  if (draft.skipped) return { skipped: true }
  const typed = draft.other.trim()
  if (!question.choices?.length) return typed ? { text: typed } : undefined
  if (!question.multiSelect) {
    if (draft.useOther) return typed ? { text: typed } : undefined
    return draft.selected[0] ? { choices: [draft.selected[0]] } : undefined
  }
  if (!draft.selected.length) return typed ? { text: typed } : undefined
  return { choices: typed ? [...draft.selected, typed] : draft.selected }
}

function describeResponse(response: ClarifyResponse | undefined): string {
  if (!response) return 'unknown'
  if ('skipped' in response) return 'skipped'
  if ('text' in response) return response.text
  return response.choices.join(', ')
}

function QuestionFields({
  question,
  draft,
  disabled,
  onChange,
  keyHints = false,
  onPicked,
}: {
  question: ClarifyQuestion
  draft: Draft
  disabled: boolean
  onChange: (draft: Draft) => void
  /** Docked above the composer: each choice shows the number key that picks it. */
  keyHints?: boolean
  /** A single-choice pick, so a docked set can move on to its next question. */
  onPicked?: () => void
}) {
  const name = useId()
  const choices = question.choices ?? []
  const single = !question.multiSelect && choices.length > 0
  const pick = (choice: string) => {
    onChange({
      ...draft,
      useOther: false,
      selected: question.multiSelect
        ? draft.selected.includes(choice)
          ? draft.selected.filter((c) => c !== choice)
          : [...draft.selected, choice]
        : [choice],
    })
    if (single) onPicked?.()
  }
  return (
    <fieldset className={styles.questionSet} disabled={disabled}>
      <legend className={styles.requestBody}>{question.question}</legend>
      {choices.map((choice, index) => (
        <label key={choice} className={styles.option}>
          <input
            type={question.multiSelect ? 'checkbox' : 'radio'}
            name={name}
            disabled={draft.skipped}
            checked={
              question.multiSelect
                ? draft.selected.includes(choice)
                : !draft.useOther && draft.selected[0] === choice
            }
            onChange={() => pick(choice)}
          />
          <span>{choice}</span>
          {keyHints && index < 9 ? (
            <kbd className={styles.optionKey} aria-hidden="true">
              {index + 1}
            </kbd>
          ) : null}
        </label>
      ))}
      {/* "Other" shares its row with the answer it stands for. */}
      <div className={styles.otherRow}>
        {single ? (
          <label className={styles.option}>
            <input
              type="radio"
              name={name}
              disabled={draft.skipped}
              checked={draft.useOther}
              onChange={() => onChange({ ...draft, useOther: true })}
            />
            <span>Other</span>
          </label>
        ) : null}
        <label className={styles.otherLabel}>
          <span className="visually-hidden">Your own answer to: {question.question}</span>
          <input
            className={styles.clarifyInput}
            placeholder={
              !choices.length
                ? 'Type your answer'
                : question.multiSelect
                  ? 'Add your own answer'
                  : 'Your own answer'
            }
            value={draft.other}
            disabled={draft.skipped}
            onChange={(event) =>
              onChange({
                ...draft,
                other: event.target.value,
                useOther: single ? true : draft.useOther,
              })
            }
          />
        </label>
      </div>
      <label className={styles.option}>
        <input
          type="checkbox"
          checked={draft.skipped}
          onChange={(event) => onChange({ ...draft, skipped: event.target.checked })}
        />
        <span>Skip this question</span>
      </label>
    </fieldset>
  )
}

/**
 * One card per open request; prompts Cindl does not answer are read-only. On
 * Talk a question set docks above the composer (`dock`), after T3 Code's
 * pending-input panel: one question at a time, with its number keys.
 */
export function RequestCard({
  request,
  layout = 'card',
}: {
  request: ServerRequest
  layout?: 'card' | 'dock'
}) {
  return request.kind === 'unsupported' ? (
    <UnsupportedCard request={request} />
  ) : (
    <DecisionCard request={request} layout={layout} />
  )
}

const asks: Record<UnsupportedRequestKind, string> = {
  sudo: 'a sudo password',
  secret: 'a secret value',
  vault: 'a vault password or code',
  other: 'an answer Cindl cannot send',
}

/**
 * Hermes is blocked on a prompt that Cindl must never answer: any reply,
 * even a decline, can become the password or secret Hermes uses. The card
 * says what Hermes is waiting for and offers nothing to send, so the prompt
 * stays open for another Hermes surface. That holds for app-level prompts
 * (no conversation) too: Cindl starts no operation that asks one, so the ones
 * it lists belong to the surface that did.
 */
function UnsupportedCard({ request }: { request: ServerRequest }) {
  const titleId = useId()
  const kind = request.unsupportedKind ?? 'other'
  return (
    <section
      id={requestDomId(request)}
      className={styles.request}
      data-kind="unsupported"
      aria-labelledby={titleId}
    >
      <header className={styles.requestHeader}>
        <span className={styles.requestKind}>
          <KeyRound size={14} aria-hidden="true" />
          Answer outside Cindl
        </span>
        <h3 id={titleId} className={styles.requestTitle} tabIndex={-1}>
          <span className="visually-hidden">Answer outside Cindl: </span>
          {request.title}
        </h3>
      </header>
      <p className={styles.requestBody}>
        Hermes is waiting for {asks[kind]}.{' '}
        {kind === 'other'
          ? 'Cindl does not support this kind of prompt and sends nothing for it.'
          : 'Cindl never collects passwords, secrets or codes and sends nothing for this prompt.'}{' '}
        {request.conversationId === undefined
          ? 'Answer it in the Hermes app that started the operation: Hermes asks only there. It stays open here until Hermes closes it.'
          : 'Answer it in another Hermes surface, such as the Hermes terminal. It stays open here until Hermes closes it.'}
      </p>
    </section>
  )
}

/**
 * Structured decision card. Shows exactly what will run (as Hermes redacted
 * it) and only the choices Hermes offered that Cindl may send. A clarify set
 * is answered in one submission. Buttons lock on the first click so a quick
 * second click cannot send a second answer.
 */
function DecisionCard({
  request,
  layout,
}: {
  request: ServerRequest
  layout: 'card' | 'dock'
}) {
  const api = useCindlApi()
  const titleId = useId()
  const [step, setStep] = useState(0)
  const bodyId = useId()
  const [folded, setFoldedState] = useState(
    () => layout === 'dock' && foldedRequests.has(request.requestId),
  )
  const setFolded = (to: boolean) => {
    if (to) foldedRequests.add(request.requestId)
    else foldedRequests.delete(request.requestId)
    setFoldedState(to)
  }
  const advance = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(advance.current), [])
  const [error, setError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const [drafts, setDraftsState] = useState<Record<string, Draft>>(
    () => draftsByRequest.get(request.requestId) ?? {},
  )
  const setDraft = (qid: string, draft: Draft) =>
    setDraftsState((current) => {
      const next = { ...current, [qid]: draft }
      draftsByRequest.set(request.requestId, next)
      return next
    })
  // A ref, not state: two clicks in the same task must not both send.
  const sending = useRef(false)
  const busy = submitting || request.status === 'answering'
  const send = async (answer: RequestAnswer) => {
    if (sending.current || request.status === 'answering') return
    sending.current = true
    setSubmitting(true)
    setError(undefined)
    try {
      await api.call('request.answer', { requestId: request.requestId, answer })
    } catch (err) {
      setError(
        isCindlError(err) &&
          ['conflict', 'invalid', 'not-found', 'unsupported'].includes(err.code)
          ? err.message
          : uncertain,
      )
    } finally {
      // This lock covers only the call. While Hermes acknowledges, the store
      // says `answering`; if the answer then fails, the store reopens the
      // request and the card must be usable again.
      sending.current = false
      setSubmitting(false)
    }
  }
  const approval = request.kind === 'approval'
  const Icon = approval ? ShieldAlert : HelpCircle
  const locked = request.lockedAnswers ?? {}
  const lockedQuestions = (request.questions ?? []).filter((q) =>
    Object.hasOwn(locked, q.qid),
  )
  // Only questions nobody has answered yet are Cindl's to answer; a locked
  // answer from another device is shown, never overridden.
  const questions = (request.questions ?? []).filter((q) => !Object.hasOwn(locked, q.qid))
  const quick =
    questions.length === 1 &&
    !questions[0]?.multiSelect &&
    Boolean(questions[0]?.choices?.length)
  // Question ids come from Hermes: read and build these records by own keys only,
  // so ids such as `constructor` or `__proto__` behave like any other id.
  const draftFor = (qid: string) =>
    Object.hasOwn(drafts, qid) ? drafts[qid] : emptyDraft
  const answers: Record<string, ClarifyResponse> = Object.fromEntries(
    questions.flatMap((question) => {
      const response = responseFor(question, draftFor(question.qid) ?? emptyDraft)
      return response ? [[question.qid, response] as const] : []
    }),
  )
  const complete = clarifyAnswersComplete(request, answers)
  // Docked, a set shows one question at a time; every draft stays kept.
  const stepper = layout === 'dock' && !approval && questions.length > 1
  const at = Math.min(step, Math.max(questions.length - 1, 0))
  const shown = stepper ? questions.slice(at, at + 1) : questions
  const goTo = (to: number) => {
    window.clearTimeout(advance.current)
    setStep(Math.max(0, Math.min(to, questions.length - 1)))
  }
  // A single-choice pick moves on after a moment, so the pick is seen first.
  const pickedAt = (index: number) => () => {
    if (!stepper || index >= questions.length - 1) return
    window.clearTimeout(advance.current)
    advance.current = window.setTimeout(() => goTo(index + 1), 200)
  }
  // Number keys pick the shown question's choices, unless typing in its own answer.
  const numberKeys = (event: KeyboardEvent<HTMLElement>) => {
    // A quick question sends on its button: one stray key must never answer it.
    // Folded away, its choices are out of sight and out of reach.
    if (layout !== 'dock' || busy || quick || folded) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text') return
    if (!/^[1-9]$/.test(event.key)) return
    const question = shown[0]
    const choice = question?.choices?.[Number(event.key) - 1]
    if (!question || !choice) return
    event.preventDefault()
    const draft = draftFor(question.qid) ?? emptyDraft
    if (draft.skipped) return
    setDraft(question.qid, {
      ...draft,
      useOther: false,
      selected: question.multiSelect
        ? draft.selected.includes(choice)
          ? draft.selected.filter((c) => c !== choice)
          : [...draft.selected, choice]
        : [choice],
    })
    if (!question.multiSelect) pickedAt(questions.indexOf(question))()
  }

  const foldLabel = `${folded ? 'Show' : 'Hide'} ${
    questions.length > 1 ? 'the questions' : 'the question'
  }`

  return (
    <section
      id={requestDomId(request)}
      className={styles.request}
      data-kind={request.kind}
      data-layout={layout}
      data-folded={folded ? 'true' : undefined}
      aria-labelledby={titleId}
      onKeyDown={numberKeys}
    >
      <header className={styles.requestHeader}>
        <span className={styles.requestKind}>
          <Icon size={14} aria-hidden="true" />
          {approval
            ? 'Approval needed'
            : questions.length > 1
              ? `${questions.length} questions`
              : 'Question'}
        </span>
        <h3 id={titleId} className={styles.requestTitle} tabIndex={-1}>
          <span className="visually-hidden">
            {approval ? 'Approval needed: ' : 'Question: '}
          </span>
          {request.title}
        </h3>
        {stepper && !folded ? (
          <span className={styles.stepper}>
            <span className={styles.stepCount}>
              {at + 1} of {questions.length}
            </span>
            <Button
              variant="quiet"
              icon
              className={styles.stepButton}
              aria-label="Previous question"
              disabled={at === 0}
              onClick={() => goTo(at - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="quiet"
              icon
              className={styles.stepButton}
              aria-label="Next question"
              disabled={at >= questions.length - 1}
              onClick={() => goTo(at + 1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </Button>
          </span>
        ) : null}
        {layout === 'dock' ? (
          // Folds the set down to this line, to read the conversation; nothing is answered.
          <Button
            variant="quiet"
            icon
            className={styles.stepButton}
            aria-expanded={!folded}
            aria-controls={bodyId}
            aria-label={foldLabel}
            title={foldLabel}
            onClick={() => setFolded(!folded)}
          >
            {folded ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
          </Button>
        ) : null}
      </header>
      <div id={bodyId} className={styles.requestContent} hidden={folded}>
        {!approval && lockedQuestions.length ? (
          <ul className={styles.lockedList} aria-label="Answered on another device">
            {lockedQuestions.map((question) => (
              <li key={question.qid}>
                <span className={styles.lockedQuestion}>{question.question}</span>
                <span className={styles.lockedAnswer}>
                  Answered on another device: {describeResponse(locked[question.qid])}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {approval ? (
          <>
            {request.command ? (
              <pre className={styles.command} aria-label="Command">
                <code>{request.command}</code>
              </pre>
            ) : null}
            {request.description ? (
              <p className={styles.requestBody}>{request.description}</p>
            ) : null}
            {request.choices.length ? (
              <div className={styles.requestFooter}>
                <p className={styles.requestScope}>Applies to this action only.</p>
                <div className={styles.requestActions}>
                  {request.choices.includes('deny') ? (
                    <Button
                      disabled={busy}
                      onClick={() => void send({ kind: 'approval', choice: 'deny' })}
                    >
                      Deny
                    </Button>
                  ) : null}
                  {request.choices.includes('once') ? (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void send({ kind: 'approval', choice: 'once' })}
                    >
                      Allow once
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className={styles.requestNote}>
                Hermes did not offer a choice Cindl can send. Answer this on the Hermes
                host.
              </p>
            )}
            {request.withheldChoices?.length ? (
              <details className={styles.requestDetails}>
                <summary>Why only once?</summary>
                <p>
                  Hermes also offers approval for the rest of the session or permanently.
                  Cindl only sends one-time decisions; make broader grants on the Hermes
                  host if you want them.
                </p>
              </details>
            ) : null}
          </>
        ) : !questions.length ? (
          <p className={styles.requestNote}>
            Every question was answered on another device. Hermes is using those answers.
          </p>
        ) : quick && questions[0] ? (
          <div className={styles.question}>
            <p className={styles.requestBody}>{questions[0].question}</p>
            <div className={styles.choiceList}>
              {(questions[0].choices ?? []).map((choice) => (
                <Button
                  key={choice}
                  disabled={busy}
                  onClick={() =>
                    void send({
                      kind: 'clarify',
                      answers: { [questions[0]?.qid ?? '']: { choices: [choice] } },
                    })
                  }
                >
                  {choice}
                </Button>
              ))}
            </div>
            <div className={styles.clarifyActions}>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() =>
                  void send({
                    kind: 'clarify',
                    answers: { [questions[0]?.qid ?? '']: { skipped: true } },
                  })
                }
              >
                Skip
              </Button>
            </div>
          </div>
        ) : (
          <form
            className={styles.questionForm}
            onSubmit={(event) => {
              event.preventDefault()
              if (complete) void send({ kind: 'clarify', answers })
            }}
          >
            {shown.map((question) => (
              <QuestionFields
                key={question.qid}
                question={question}
                draft={draftFor(question.qid) ?? emptyDraft}
                disabled={busy}
                onChange={(draft) => setDraft(question.qid, draft)}
                keyHints={layout === 'dock'}
                onPicked={pickedAt(questions.indexOf(question))}
              />
            ))}
            <div className={styles.requestFooter}>
              <p className={styles.requestScope}>
                {complete
                  ? 'Ready to send all answers together.'
                  : 'Answer or skip each question, then send once.'}
              </p>
              <div className={styles.requestActions}>
                <Button
                  variant="quiet"
                  disabled={busy}
                  // There is no "decline": an empty reply reads to the agent like an
                  // interrupt. Skipping every open question gives each a clean "skipped".
                  onClick={() =>
                    void send({
                      kind: 'clarify',
                      answers: Object.fromEntries(
                        questions.map((question) => [
                          question.qid,
                          { skipped: true as const },
                        ]),
                      ),
                    })
                  }
                >
                  Skip all
                </Button>
                <Button type="submit" variant="primary" disabled={busy || !complete}>
                  Send answers
                </Button>
              </div>
            </div>
          </form>
        )}
        {busy && !error ? (
          <p className={styles.requestNote} role="status">
            Sending your answer…
          </p>
        ) : null}
        {error ? (
          <p className={styles.requestError} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
