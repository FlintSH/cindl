import { useTool } from '@cindl/client-react'
import type { ToolStatus } from '@cindl/contracts'
import { Ban, Check, ChevronRight, CircleAlert, Hand, LoaderCircle } from 'lucide-react'
import { duration } from './format.ts'
import styles from './talk.module.css'

/** Shared by the step row and its evidence in the margin (Android's toolStatusLabel). */
export const toolStatusLabel: Record<ToolStatus, string> = {
  generating: 'Preparing',
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
}

/** Only an actively executing step spins; a step blocked on the owner shows a still hand. */
export function ToolIcon({
  status,
  blocked = false,
}: {
  status: ToolStatus
  blocked?: boolean
}) {
  if (blocked) return <Hand size={14} aria-hidden="true" />
  if (status === 'complete') return <Check size={14} aria-hidden="true" />
  if (status === 'error') return <CircleAlert size={14} aria-hidden="true" />
  if (status === 'cancelled') return <Ban size={14} aria-hidden="true" />
  return <LoaderCircle size={14} aria-hidden="true" className={styles.spin} />
}

export function ToolRow({
  toolId,
  selected,
  blocked,
  onSelect,
}: {
  toolId: string
  selected: boolean
  blocked: boolean
  onSelect: (toolId: string) => void
}) {
  const tool = useTool(toolId)
  if (!tool) return null
  const time = duration(tool.startedAt, tool.endedAt)
  const state = blocked ? 'Waiting for you' : toolStatusLabel[tool.status]
  const meta = blocked
    ? 'Waiting for you'
    : tool.status === 'complete'
      ? time
      : (tool.progress ?? toolStatusLabel[tool.status])
  return (
    <button
      type="button"
      className={styles.tool}
      data-status={blocked ? 'blocked' : tool.status}
      data-tool-id={tool.id}
      aria-pressed={selected}
      onClick={() => onSelect(tool.id)}
    >
      <span className={styles.toolIcon}>
        <ToolIcon status={tool.status} blocked={blocked} />
      </span>
      {/* The live step's label shimmers, as in T3 Code; a blocked one is still. */}
      <span
        className={styles.toolTitle}
        data-live={
          !blocked && (tool.status === 'running' || tool.status === 'generating')
            ? 'true'
            : undefined
        }
      >
        {tool.title}
      </span>
      <span className={styles.toolMeta} aria-hidden="true">
        {meta}
      </span>
      <span className="visually-hidden">{state}. Show details.</span>
      <ChevronRight size={14} aria-hidden="true" className={styles.toolChevron} />
    </button>
  )
}
