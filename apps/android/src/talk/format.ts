/** Time and duration copy shared with the web client (apps/web/src/talk/format.ts). */
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

/** A moment inside a sentence: "today at 9:55 PM", "on Monday at 9:55 PM", "on Jun 2 at 9:55 PM". */
export function momentInSentence(iso?: string, now = new Date()): string | undefined {
  const day = relativeDay(iso, now)
  const time = clockTime(iso)
  if (!day || !time) return undefined
  const when = day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`
  return `${when} at ${time}`
}

/** Subsequence match used by the conversation search (same scoring as web). */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let position = -1
  let score = 0
  for (const char of q) {
    const next = t.indexOf(char, position + 1)
    if (next < 0) return undefined
    score += next - position - 1
    position = next
  }
  return score + (t.startsWith(q) ? -100 : 0)
}
