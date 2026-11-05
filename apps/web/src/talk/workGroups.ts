import type { MessagePart, ToolStatus } from '@cindl/contracts'
import { duration } from './format.ts'

/**
 * A reply's parts as the timeline lays them out (after T3 Code's work log):
 * two or more consecutive steps become one work group, which reads as a
 * single line once they are done; a lone step stays a step.
 */
export type Segment =
  | { kind: 'part'; index: number; part: MessagePart }
  | { kind: 'work'; key: string; toolIds: string[] }

export function segmentsOf(parts: readonly MessagePart[]): Segment[] {
  const out: Segment[] = []
  let run: Array<{ index: number; toolId: string }> = []
  const flush = () => {
    const [first] = run
    if (run.length >= 2 && first)
      out.push({ kind: 'work', key: first.toolId, toolIds: run.map((r) => r.toolId) })
    else if (first)
      out.push({
        kind: 'part',
        index: first.index,
        part: { type: 'tool', toolId: first.toolId },
      })
    run = []
  }
  parts.forEach((part, index) => {
    if (part.type === 'tool') run.push({ index, toolId: part.toolId })
    else {
      flush()
      out.push({ kind: 'part', index, part })
    }
  })
  flush()
  return out
}

export interface StepFacts {
  status: ToolStatus | 'missing'
  startedAt?: string | undefined
  endedAt?: string | undefined
  blocked: boolean
}

export interface WorkSummary {
  count: number
  failed: number
  cancelled: number
  /** Still preparing or running, and not blocked on the owner. */
  live: number
  blocked: number
  /** Every step finished (done, failed or cancelled). */
  settled: boolean
  /** From the first step's start to the last one's end, when every step has both. */
  took: string | undefined
  /** The line a collapsed group reads as: "4 steps", "4 steps, 1 failed". */
  label: string
}

const finished = new Set<StepFacts['status']>(['complete', 'error', 'cancelled'])

export function summarize(steps: readonly StepFacts[]): WorkSummary {
  const failed = steps.filter((s) => s.status === 'error').length
  const cancelled = steps.filter((s) => s.status === 'cancelled').length
  const blocked = steps.filter((s) => s.blocked).length
  const live = steps.filter(
    (s) => !s.blocked && (s.status === 'running' || s.status === 'generating'),
  ).length
  const settled = steps.every((s) => finished.has(s.status))
  const starts = steps.map((s) => s.startedAt)
  const ends = steps.map((s) => s.endedAt)
  const took =
    settled && starts.every(Boolean) && ends.every(Boolean)
      ? duration(
          starts.reduce((a, b) => ((b ?? '') < (a ?? '') ? b : a)),
          ends.reduce((a, b) => ((b ?? '') > (a ?? '') ? b : a)),
        )
      : undefined
  const parts = [`${steps.length} steps`]
  if (failed) parts.push(`${failed} failed`)
  if (cancelled) parts.push(`${cancelled} cancelled`)
  return {
    count: steps.length,
    failed,
    cancelled,
    live,
    blocked,
    settled,
    took,
    label: parts.join(', '),
  }
}

/**
 * Whether a group opens by default: while it works, waits on the owner, or
 * holds a failure, its steps stay in view; once all went well it folds into
 * its one line. The owner's own choice, once made, wins.
 */
export function startsOpen(summary: WorkSummary): boolean {
  return !summary.settled || summary.blocked > 0 || summary.failed > 0
}

/** The owner's open or closed choice per group, for this session (groups remount with views). */
const chosen = new Map<string, boolean>()
export const groupChoice = {
  get: (key: string) => chosen.get(key),
  set: (key: string, open: boolean) => void chosen.set(key, open),
  forget: () => chosen.clear(),
}
