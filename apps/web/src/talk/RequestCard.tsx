import { useCindlApi } from '@cindl/client-react'
import { isCindlError, type RequestAnswer, type ServerRequest } from '@cindl/contracts'
import { HelpCircle, ShieldAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './talk.module.css'

export const requestDomId = (request: Pick<ServerRequest, 'rpcId' | 'connectionEpoch'>) =>
  `request-${request.connectionEpoch}-${String(request.rpcId).replace(/[^A-Za-z0-9_-]/g, '_')}`

/**
 * Structured decision card. Shows exactly what will run (as Hermes redacted
 * it) and only the choices Hermes offered that Cindl may send. One decision
 * per request; the server is the authority on whether it still applies.
 * Distinguished by its label, heading and border, not by a decorative rail.
 */
export function RequestCard({ request }: { request: ServerRequest }) {
  const api = useCindlApi()
  const titleId = useId()
  const [error, setError] = useState<string>()
  const [clarifyText, setClarifyText] = useState('')
  const busy = request.status === 'answering'
  const send = async (answer: RequestAnswer) => {
    setError(undefined)
    try {
      await api.call('request.answer', {
        rpcId: request.rpcId,
        connectionEpoch: request.connectionEpoch,
        answer,
      })
    } catch (err) {
      setError(
        isCindlError(err)
          ? err.message
          : 'The answer could not be sent. Nothing was approved.',
      )
    }
  }
  const approval = request.kind === 'approval'
  const Icon = approval ? ShieldAlert : HelpCircle
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
          {approval ? 'Approval needed' : 'Question'}
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
      ) : (
        <>
          {(request.questions ?? []).map((question) => (
            <div key={question.qid} className={styles.question}>
              <p className={styles.requestBody}>{question.question}</p>
              {question.choices?.length ? (
                <div className={styles.choiceList}>
                  {question.choices.map((choice) => (
                    <Button
                      key={choice}
                      disabled={busy}
                      onClick={() =>
                        void send({
                          kind: 'clarify',
                          answers: { [question.qid]: choice },
                        })
                      }
                    >
                      {choice}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          <form
            className={styles.clarifyForm}
            onSubmit={(event) => {
              event.preventDefault()
              const qid = request.questions?.[0]?.qid
              if (!qid || !clarifyText.trim()) return
              void send({ kind: 'clarify', answers: { [qid]: clarifyText.trim() } })
            }}
          >
            <label className="visually-hidden" htmlFor={`${titleId}-text`}>
              Your answer
            </label>
            <input
              id={`${titleId}-text`}
              className={styles.clarifyInput}
              placeholder="Or type an answer"
              value={clarifyText}
              disabled={busy}
              onChange={(event) => setClarifyText(event.target.value)}
            />
            <div className={styles.clarifyActions}>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => void send({ kind: 'clarify-cancel' })}
              >
                Skip
              </Button>
              <Button type="submit" disabled={busy || !clarifyText.trim()}>
                Send
              </Button>
            </div>
          </form>
        </>
      )}
      {busy ? (
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
