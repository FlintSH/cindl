import { useCindlApi } from '@cindl/client-react'
import {
  clarifyAnswersComplete,
  isCindlError,
  type ClarifyQuestion,
  type ClarifyResponse,
  type RequestAnswer,
  type ServerRequest,
} from '@cindl/contracts'
import { HelpCircle, ShieldAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './talk.module.css'

export const requestDomId = (request: Pick<ServerRequest, 'requestId'>) =>
  `request-${request.requestId.replace(/[^A-Za-z0-9_-]/g, '_')}`

/** Unknown failures may still have reached Hermes; never claim nothing happened. */
const uncertain =
  'Cindl could not confirm your answer. Hermes may have received it; check before answering again.'

type Draft = { selected: string[]; other: string; skipped: boolean }
const emptyDraft: Draft = { selected: [], other: '', skipped: false }

function responseFor(
  question: ClarifyQuestion,
  draft: Draft,
): ClarifyResponse | undefined {
  if (draft.skipped) return { skipped: true }
  if (draft.other.trim()) return { text: draft.other.trim() }
  if (draft.selected.length)
    return { choices: question.multiSelect ? draft.selected : draft.selected.slice(0, 1) }
  return undefined
}

function QuestionFields({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: ClarifyQuestion
  draft: Draft
  disabled: boolean
  onChange: (draft: Draft) => void
}) {
  const name = useId()
  const toggle = (choice: string) =>
    onChange({
      ...draft,
      skipped: false,
      other: question.multiSelect ? draft.other : '',
      selected: question.multiSelect
        ? draft.selected.includes(choice)
          ? draft.selected.filter((c) => c !== choice)
          : [...draft.selected, choice]
        : [choice],
    })
  return (
    <fieldset className={styles.questionSet} disabled={disabled}>
      <legend className={styles.requestBody}>{question.question}</legend>
      {question.choices?.map((choice) => (
        <label key={choice} className={styles.option}>
          <input
            type={question.multiSelect ? 'checkbox' : 'radio'}
            name={name}
            checked={!draft.skipped && draft.selected.includes(choice)}
            onChange={() => toggle(choice)}
          />
          <span>{choice}</span>
        </label>
      ))}
      <label className={styles.otherLabel}>
        <span className="visually-hidden">Your own answer to: {question.question}</span>
        <input
          className={styles.clarifyInput}
          placeholder={
            question.choices?.length ? 'Or type your own answer' : 'Type your answer'
          }
          value={draft.other}
          onChange={(event) =>
            onChange({
              ...draft,
              skipped: false,
              other: event.target.value,
              selected: question.multiSelect ? draft.selected : [],
            })
          }
        />
      </label>
      <label className={styles.option}>
        <input
          type="checkbox"
          checked={draft.skipped}
          onChange={(event) => onChange({ ...emptyDraft, skipped: event.target.checked })}
        />
        <span>Skip this question</span>
      </label>
    </fieldset>
  )
}

/**
 * Structured decision card. Shows exactly what will run (as Hermes redacted
 * it) and only the choices Hermes offered that Cindl may send. A clarify set
 * is answered in one submission. Buttons lock on the first click so a quick
 * second click cannot send a second answer.
 */
export function RequestCard({ request }: { request: ServerRequest }) {
  const api = useCindlApi()
  const titleId = useId()
  const [error, setError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const busy = submitting || request.status === 'answering'
  const send = async (answer: RequestAnswer) => {
    if (busy) return
    setSubmitting(true)
    setError(undefined)
    try {
      await api.call('request.answer', { requestId: request.requestId, answer })
    } catch (err) {
      setError(
        isCindlError(err) && ['conflict', 'invalid', 'not-found'].includes(err.code)
          ? err.message
          : uncertain,
      )
      setSubmitting(false)
    }
  }
  const approval = request.kind === 'approval'
  const Icon = approval ? ShieldAlert : HelpCircle
  const questions = request.questions ?? []
  const quick =
    questions.length === 1 &&
    !questions[0]?.multiSelect &&
    Boolean(questions[0]?.choices?.length)
  const answers: Record<string, ClarifyResponse> = {}
  for (const question of questions) {
    const response = responseFor(question, drafts[question.qid] ?? emptyDraft)
    if (response) answers[question.qid] = response
  }
  const complete = clarifyAnswersComplete(request, answers)

  return (
    <section
      id={requestDomId(request)}
      className={styles.request}
      data-kind={request.kind}
      aria-labelledby={titleId}
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
      </header>
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
          {questions.map((question) => (
            <QuestionFields
              key={question.qid}
              question={question}
              draft={drafts[question.qid] ?? emptyDraft}
              disabled={busy}
              onChange={(draft) =>
                setDrafts((current) => ({ ...current, [question.qid]: draft }))
              }
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
                onClick={() => void send({ kind: 'clarify-cancel' })}
              >
                Decline all
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
    </section>
  )
}
