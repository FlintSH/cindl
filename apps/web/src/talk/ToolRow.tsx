import { useTool } from '@cindl/client-react'
import type { ToolStatus } from '@cindl/contracts'
import { Ban, Check, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react'
import { duration } from './format.ts'
import styles from './talk.module.css'

const statusLabel: Record<ToolStatus, string> = {
  generating: 'Preparing',
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
}

export function ToolIcon({ status }: { status: ToolStatus }) {
  if (status === 'complete') return <Check size={14} aria-hidden="true" />
  if (status === 'error') return <CircleAlert size={14} aria-hidden="true" />
  if (status === 'cancelled') return <Ban size={14} aria-hidden="true" />
  return <LoaderCircle size={14} aria-hidden="true" className={styles.spin} />
}

export function ToolRow({
  toolId,
  selected,
  onSelect,
}: {
  toolId: string
  selected: boolean
  onSelect: (toolId: string) => void
}) {
  const tool = useTool(toolId)
  if (!tool) return null
  const time = duration(tool.startedAt, tool.endedAt)
  return (
    <button
      type="button"
      className={styles.tool}
      data-status={tool.status}
      aria-pressed={selected}
      onClick={() => onSelect(tool.id)}
    >
      <span className={styles.toolIcon}>
        <ToolIcon status={tool.status} />
      </span>
      <span className={styles.toolTitle}>{tool.title}</span>
      <span className={styles.toolMeta}>
        {tool.status === 'complete' ? time : (tool.progress ?? statusLabel[tool.status])}
      </span>
      <span className="visually-hidden">{statusLabel[tool.status]}. Show details.</span>
      <ChevronRight size={14} aria-hidden="true" className={styles.toolChevron} />
    </button>
  )
}
