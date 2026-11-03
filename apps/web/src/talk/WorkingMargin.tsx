import { useOpenRequests, useTool } from '@cindl/client-react'
import { X } from 'lucide-react'
import { Button, SectionTitle } from '../ui/primitives.tsx'
import { duration } from './format.ts'
import { RequestCard } from './RequestCard.tsx'
import { ToolIcon } from './ToolRow.tsx'
import styles from './talk.module.css'

function Evidence({ toolId }: { toolId: string }) {
  const tool = useTool(toolId)
  if (!tool)
    return <p className={styles.marginEmpty}>This step is no longer available.</p>
  return (
    <div className={styles.evidence}>
      <p className={styles.evidenceTitle}>
        <ToolIcon status={tool.status} /> {tool.title}
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
}: {
  conversationId: string
  selectedToolId: string | undefined
  onClearSelection: () => void
  onClose: () => void
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
          <Evidence toolId={selectedToolId} />
        ) : requests.length ? (
          requests.map((request) => (
            <RequestCard
              key={`${request.connectionEpoch}:${request.rpcId}`}
              request={request}
              compact
            />
          ))
        ) : (
          <p className={styles.marginEmpty}>
            Nothing is waiting on you here. Select a step to see what Hermes did.
          </p>
        )}
      </div>
    </aside>
  )
}
