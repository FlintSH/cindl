import { useTool } from '@cindl/client-react'
import type { ToolStatus } from '@cindl/contracts'
import { Ban, Check, ChevronRight, CircleAlert, Hand, LoaderCircle } from 'lucide-react'
import { duration } from './format.ts'
import styles from './talk.module.css'

const statusLabel: Record<ToolStatus, string> = {
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
  const state = blocked ? 'Waiting for you' : statusLabel[tool.status]
  const meta = blocked
    ? 'Waiting for you'
    : tool.status === 'complete'
      ? time
      : (tool.progress ?? statusLabel[tool.status])
  return (
    <button
      type="button"
      className={styles.tool}
      data-status={blocked ? 'blocked' : tool.status}
      aria-pressed={selected}
      onClick={() => onSelect(tool.id)}
    >
      <span className={styles.toolIcon}>
        <ToolIcon status={tool.status} blocked={blocked} />
      </span>
      <span className={styles.toolTitle}>{tool.title}</span>
      <span className={styles.toolMeta} aria-hidden="true">
        {meta}
      </span>
      <span className="visually-hidden">{state}. Show details.</span>
      <ChevronRight size={14} aria-hidden="true" className={styles.toolChevron} />
    </button>
  )
}
