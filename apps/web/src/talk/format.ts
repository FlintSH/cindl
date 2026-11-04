import type { Routine } from '@cindl/contracts'

export function duration(
  startedAt?: string,
  endedAt?: string,
  now = Date.now(),
): string | undefined {
  if (!startedAt) return undefined
  const ms = (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return '<1s'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** "8:03 AM" (or "08:03" where the locale writes the hour so); never seconds. */
export function clockTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function relativeDay(iso?: string, now = new Date()): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return date.toLocaleDateString([], { weekday: 'long' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * A message's time, aware of the day: the clock today, then "Yesterday,
 * 8:03 AM", a weekday within the week, else "Jun 2, 8:03 AM".
 */
export function messageTime(iso?: string, now = new Date()): string | undefined {
  const day = relativeDay(iso, now)
  const time = clockTime(iso)
  if (!day || !time) return undefined
  return day === 'Today' ? time : `${day}, ${time}`
}

/** In a list of conversations: the clock for today, else the day ("Yesterday", "Jun 2"). */
export function listTime(iso?: string, now = new Date()): string | undefined {
  const day = relativeDay(iso, now)
  return day === 'Today' ? clockTime(iso) : day
}

/** The whole moment, for a tooltip: "Tuesday, June 2, 2026 at 8:03 AM". */
export function fullTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })
}

/**
 * A live timer since `since`: "12s", "1m 5s", "1h 2m"; nothing under a
 * second or for a start in the future (another clock). It rounds down, so it
 * only ever counts up.
 */
export function elapsed(since?: string, now = Date.now()): string | undefined {
  if (!since) return undefined
  const ms = now - Date.parse(since)
  if (!Number.isFinite(ms) || ms < 1000) return undefined
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const runOutcome: Record<NonNullable<Routine['lastRun']>['status'], string> = {
  ok: 'succeeded',
  error: 'failed',
  skipped: 'skipped',
  running: 'still running',
  unknown: 'outcome unknown',
}

/**
 * A routine's line under its name: its schedule, when it runs next (while it
 * is active) and how its last run went, in words: "Weekdays at 07:30 · next
 * today at 7:30 AM · last run on Jun 2 at 7:30 AM, succeeded".
 */
export function routineDetail(
  routine: Pick<Routine, 'schedule' | 'enabled' | 'nextRunAt' | 'lastRun'>,
  now = new Date(),
): string {
  const parts = [routine.schedule]
  const next = routine.enabled ? momentInSentence(routine.nextRunAt, now) : undefined
  if (next) parts.push(`next ${next}`)
  if (routine.lastRun)
    parts.push(
      `last run ${momentInSentence(routine.lastRun.at, now) ?? 'at an unknown time'}, ${runOutcome[routine.lastRun.status]}`,
    )
  return parts.join(' · ')
}

/** A moment inside a sentence: "today at 9:55 PM", "on Monday at 9:55 PM", "on Jun 2 at 9:55 PM". */
export function momentInSentence(iso?: string, now = new Date()): string | undefined {
  const day = relativeDay(iso, now)
  const time = clockTime(iso)
  if (!day || !time) return undefined
  const when = day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`
  return `${when} at ${time}`
}
