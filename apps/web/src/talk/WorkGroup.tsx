import { entry } from '@cindl/client-core'
import { useCindlState } from '@cindl/client-react'
import type { ToolStatus } from '@cindl/contracts'
import { Check, ChevronRight, CircleAlert, Hand, LoaderCircle } from 'lucide-react'
import { useMemo, useReducer } from 'react'
import { ToolRow } from './ToolRow.tsx'
import { groupChoice, startsOpen, summarize, type StepFacts } from './workGroups.ts'
import styles from './talk.module.css'

/** The group's steps as plain facts, selected as one string so the snapshot stays stable. */
function useStepFacts(
  toolIds: readonly string[],
  blocked: ReadonlySet<string>,
): StepFacts[] {
  const key = useCindlState((state) =>
    toolIds
      .map((id) => {
        const tool = entry(state.tools, id)
        return tool
          ? `${tool.status}|${tool.startedAt ?? ''}|${tool.endedAt ?? ''}`
          : 'missing||'
      })
      .join(','),
  )
  return useMemo(
    () =>
      key.split(',').map((row, index) => {
        const [status = 'missing', startedAt, endedAt] = row.split('|')
        return {
          status: status as ToolStatus | 'missing',
          startedAt: startedAt || undefined,
          endedAt: endedAt || undefined,
          blocked: blocked.has(toolIds[index] ?? ''),
        }
      }),
    [key, blocked, toolIds],
  )
}

/**
 * Consecutive steps as one work log (after T3 Code): a line that says how
 * many steps and how long they took, opening into the steps themselves. It
 * stays open while Hermes works, waits on the owner or has a failure, and
 * while a step in it is selected; the owner's own open or closed choice wins.
 */
export function WorkGroup({
  groupKey,
  toolIds,
  selectedToolId,
  blockedToolIds,
  onSelectTool,
}: {
  groupKey: string
  toolIds: readonly string[]
  selectedToolId: string | undefined
  blockedToolIds: ReadonlySet<string>
  onSelectTool: (toolId: string) => void
}) {
  const facts = useStepFacts(toolIds, blockedToolIds)
  const summary = summarize(facts)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const holdsSelection = selectedToolId !== undefined && toolIds.includes(selectedToolId)
  const open = holdsSelection || (groupChoice.get(groupKey) ?? startsOpen(summary))
  const icon =
    summary.blocked > 0 ? (
      <Hand size={14} aria-hidden="true" />
    ) : summary.live > 0 ? (
      <LoaderCircle size={14} aria-hidden="true" className={styles.spin} />
    ) : summary.failed > 0 ? (
      <CircleAlert size={14} aria-hidden="true" />
    ) : (
      <Check size={14} aria-hidden="true" />
    )
  const state =
    summary.blocked > 0
      ? 'blocked'
      : summary.live > 0
        ? 'running'
        : summary.failed > 0
          ? 'error'
          : 'complete'
  return (
    <div className={styles.workGroup}>
      <button
        type="button"
        className={styles.workHead}
        data-status={state}
        aria-expanded={open}
        onClick={() => {
          groupChoice.set(groupKey, !open)
          rerender()
        }}
      >
        <span className={styles.toolIcon}>{icon}</span>
        <span className={styles.workLabel}>{summary.label}</span>
        <span className={styles.toolMeta}>
          {summary.took ??
            (summary.blocked ? 'Waiting for you' : summary.live ? 'Working' : '')}
        </span>
        <ChevronRight size={14} aria-hidden="true" className={styles.workChevron} />
      </button>
      {open ? (
        <div className={styles.workSteps}>
          {toolIds.map((toolId) => (
            <ToolRow
              key={toolId}
              toolId={toolId}
              selected={selectedToolId === toolId}
              blocked={blockedToolIds.has(toolId)}
              onSelect={onSelectTool}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
