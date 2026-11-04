import { useOpenRequests, useTool } from '@cindl/client-react'
import type { ServerRequest } from '@cindl/contracts'
import { HelpCircle, KeyRound, ShieldAlert, X } from 'lucide-react'
import { useId, useRef, type KeyboardEvent } from 'react'
import { Button, SectionTitle } from '../ui/primitives.tsx'
import { RequireCapability } from '../views/Capability.tsx'
import { Computer } from '../work/WorkView.tsx'
import { duration } from './format.ts'
import { keepPlace, useMarginTool, useSelectedStep, type MarginTool } from './places.ts'
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
 * The working margin: the conversation's panel (ADR 0013). A few tools for
 * this conversation, switched by the owner and never by the agent: what it
 * waits on, the selected step's evidence and the agent's computer. The
 * actionable cards live in the conversation; the margin only points to them,
 * so one request never shows two sets of decision buttons.
 */
export function WorkingMargin({
  conversationId,
  onClose,
  onShowRequest,
}: {
  conversationId: string
  onClose: () => void
  /** Reveal the request's card in the conversation (closing any modal sheet first). */
  onShowRequest: (request: ServerRequest) => void
}) {
  const requests = useOpenRequests(conversationId)
  const selectedToolId = useSelectedStep(conversationId)
  const tool = useMarginTool(conversationId)
  const id = useId()
  const tabs = useRef(new Map<MarginTool, HTMLButtonElement | null>())
  const tools: Array<{ id: MarginTool; label: string; count?: number }> = [
    { id: 'waiting', label: 'Waiting', count: requests.length },
    { id: 'step', label: 'Step' },
    { id: 'computer', label: 'Computer' },
  ]
  const choose = (next: MarginTool) => keepPlace(conversationId, { tool: next })
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    // Alt+Left and the like belong to the browser.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    // From the tab that has focus, which need not be the selected one.
    const focused = tools.findIndex((t) => tabs.current.get(t.id) === event.target)
    const at = focused >= 0 ? focused : tools.findIndex((t) => t.id === tool)
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % tools.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tools.length) % tools.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tools.length - 1
              : undefined
    if (to === undefined) return
    event.preventDefault()
    const next = tools[to]!.id
    choose(next)
    tabs.current.get(next)?.focus()
  }
  return (
    <aside className={styles.margin} aria-label="Working margin">
      <header className={styles.marginHeader}>
        <div
          role="tablist"
          aria-label="Margin tools"
          className={styles.marginTabs}
          onKeyDown={move}
        >
          {tools.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabs.current.set(t.id, el)
              }}
              type="button"
              role="tab"
              id={`${id}-${t.id}`}
              aria-selected={tool === t.id}
              aria-controls={`${id}-panel`}
              tabIndex={tool === t.id ? 0 : -1}
              className={styles.marginTab}
              onClick={() => choose(t.id)}
            >
              {/* The name is the visible text ("Waiting 2"), so voice control finds it. */}
              {t.label}
              {t.count ? (
                <>
                  {' '}
                  <span className={styles.marginCount}>{t.count}</span>
                </>
              ) : null}
            </button>
          ))}
        </div>
        <Button
          variant="quiet"
          icon
          aria-label="Close the working margin"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div
        className={styles.marginBody}
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tool}`}
        // Reachable from the tabs even when it holds nothing focusable.
        tabIndex={0}
      >
        {tool === 'waiting' ? (
          <Waiting requests={requests} onShowRequest={onShowRequest} />
        ) : tool === 'step' ? (
          selectedToolId ? (
            <>
              <Evidence toolId={selectedToolId} blocked={requests.length > 0} />
              <div>
                <Button
                  variant="quiet"
                  onClick={() => {
                    keepPlace(conversationId, { toolId: undefined })
                    // The button goes with the step: focus stays on the tool.
                    tabs.current.get('step')?.focus()
                  }}
                >
                  Clear the step
                </Button>
              </div>
            </>
          ) : (
            <p className={styles.marginEmpty}>
              Select a step in the conversation to see what Hermes did.
            </p>
          )
        ) : (
          <RequireCapability id="computer.view" label="Agent computer">
            <Computer />
          </RequireCapability>
        )}
      </div>
    </aside>
  )
}

function Waiting({
  requests,
  onShowRequest,
}: {
  requests: ServerRequest[]
  onShowRequest: (request: ServerRequest) => void
}) {
  if (!requests.length)
    return <p className={styles.marginEmpty}>Nothing is waiting on you here.</p>
  return (
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
  )
}
