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

export function clockTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
