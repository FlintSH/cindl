import { useOpenRequests, useTool } from '@cindl/client-react'
import type { ServerRequest } from '@cindl/contracts'
import { HelpCircle, KeyRound, ShieldAlert, X } from 'lucide-react'
import { Button, SectionTitle } from '../ui/primitives.tsx'
import { duration } from './format.ts'
import { ToolIcon } from './ToolRow.tsx'
import styles from './talk.module.css'

function Evidence({ toolId, blocked }: { toolId: string; blocked: boolean }) {
  const tool = useTool(toolId)
  if (!tool)
    return <p className={styles.marginEmpty}>This step is no longer available.</p>
  return (
    <div className={styles.evidence}>
      <p className={styles.evidenceTitle}>
        <ToolIcon
          status={tool.status}
          blocked={blocked && (tool.status === 'running' || tool.status === 'generating')}
        />{' '}
        {tool.title}
      </p>
      <dl className={styles.facts}>
        <dt>Tool</dt>
        <dd>
          <code>{tool.name}</code>
        </dd>
        <dt>Status</dt>
        <dd>{tool.progress ?? tool.status}</dd>
        {duration(tool.startedAt, tool.endedAt) ? (
          <>
            <dt>Duration</dt>
            <dd>{duration(tool.startedAt, tool.endedAt)}</dd>
          </>
        ) : null}
      </dl>
      {tool.argsPreview ? (
        <>
          <SectionTitle>Input (redacted preview)</SectionTitle>
          <pre className={styles.evidenceBlock}>{tool.argsPreview}</pre>
        </>
      ) : null}
      {tool.resultPreview ? (
        <>
          <SectionTitle>Result (redacted preview)</SectionTitle>
          <pre className={styles.evidenceBlock}>{tool.resultPreview}</pre>
        </>
      ) : null}
      {tool.outputRisk ? (
        <p className={styles.notice} data-level="warning">
          Hermes flagged this output: {tool.outputRisk.reason ?? tool.outputRisk.level}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The contextual working margin: it shows the evidence you selected or what
 * this conversation is waiting on, instead of opening more panes.
 */
export function WorkingMargin({
  conversationId,
  selectedToolId,
  onClearSelection,
  onClose,
  onShowRequest,
}: {
  conversationId: string
  selectedToolId: string | undefined
  onClearSelection: () => void
  onClose: () => void
  /** Reveal the request's card in the conversation (closing any modal sheet first). */
  onShowRequest: (request: ServerRequest) => void
}) {
  const requests = useOpenRequests(conversationId)
  return (
    <aside className={styles.margin} aria-label="Working margin">
      <header className={styles.marginHeader}>
        <span className={styles.marginLabel}>
          {selectedToolId ? 'Step details' : 'Waiting on you'}
        </span>
        {selectedToolId ? (
          <Button variant="quiet" onClick={onClearSelection}>
            Back
          </Button>
        ) : null}
        <Button
          variant="quiet"
          icon
          aria-label="Close the working margin"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.marginBody}>
        {selectedToolId ? (
          <Evidence toolId={selectedToolId} blocked={requests.length > 0} />
        ) : requests.length ? (
          // The actionable card lives in the conversation; the margin only points to it,
          // so one request never shows two sets of decision buttons.
          <ul className={styles.waitingList}>
            {requests.map((request) => {
              const Icon =
                request.kind === 'approval'
                  ? ShieldAlert
                  : request.kind === 'clarify'
                    ? HelpCircle
                    : KeyRound
              const label =
                request.kind === 'approval'
                  ? 'approval'
                  : request.kind === 'clarify'
                    ? 'question'
                    : 'prompt to answer outside Cindl'
              return (
                <li key={request.requestId} className={styles.waitingRow}>
                  <Icon size={15} aria-hidden="true" />
                  <span className={styles.waitingTitle}>{request.title}</span>
                  <Button
                    variant="quiet"
                    aria-label={`Show ${label}: ${request.title}`}
                    onClick={() => onShowRequest(request)}
                  >
                    Show
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className={styles.marginEmpty}>
            Nothing is waiting on you here. Select a step to see what Hermes did.
          </p>
        )}
      </div>
    </aside>
  )
}
