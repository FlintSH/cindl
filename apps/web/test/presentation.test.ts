// @vitest-environment node
import { SYNTHETIC_DEMO_LABEL } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { pageTitle } from '../src/shell/title.ts'
import { shortcutText } from '../src/shortcuts.ts'
import {
  clockTime,
  elapsed,
  fullTime,
  listTime,
  messageTime,
  momentInSentence,
  routineDetail,
} from '../src/talk/format.ts'

describe('times', () => {
  it('writes a message time as the locale does, without a padded hour or seconds', () => {
    const iso = '2026-06-02T08:03:09'
    const time = clockTime(iso)
    expect(time).toBe(
      new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    )
    expect(time).not.toMatch(/\d:\d\d:\d\d/)
    if (Intl.DateTimeFormat().resolvedOptions().locale === 'en-US')
      expect(time).toMatch(/^8:03\sAM$/u)
    expect(clockTime('not a date')).toBeUndefined()
  })

  it('says when a document was read as part of a sentence', () => {
    const now = new Date(2026, 5, 10, 18, 0)
    const at = (days: number) => new Date(2026, 5, 10 - days, 9, 55).toISOString()
    expect(momentInSentence(at(0), now)).toMatch(/^today at \S/)
    expect(momentInSentence(at(1), now)).toMatch(/^yesterday at \S/)
    // A weekday, then a date: never a bare "Monday at".
    expect(momentInSentence(at(3), now)).toMatch(/^on \S+ at \S/)
    expect(momentInSentence(at(30), now)).toMatch(/^on \S.* at \S/)
    expect(momentInSentence(at(0), now)).not.toMatch(/\d:\d\d:\d\d/)
    expect(momentInSentence('not a date', now)).toBeUndefined()
  })
})

describe('day-aware times', () => {
  const now = new Date(2026, 5, 10, 18, 0)
  const at = (days: number, hour = 9) =>
    new Date(2026, 5, 10 - days, hour, 55).toISOString()

  it('gives a message the clock today and the day before that', () => {
    expect(messageTime(at(0), now)).toBe(clockTime(at(0)))
    expect(messageTime(at(1), now)).toBe(`Yesterday, ${clockTime(at(1))}`)
    expect(messageTime(at(30), now)).toMatch(new RegExp(`^\\S.*, ${clockTime(at(30))}$`))
    expect(messageTime(at(30), now)).not.toMatch(/^Today|^Yesterday/)
    expect(fullTime(at(0))).toContain('2026')
    expect(fullTime('not a date')).toBeUndefined()
  })

  it('lists today’s conversations by the clock, older ones by the day', () => {
    expect(listTime(at(0), now)).toBe(clockTime(at(0)))
    expect(listTime(at(1), now)).toBe('Yesterday')
  })

  it('counts a live timer up in whole seconds, then minutes, then hours', () => {
    const start = Date.parse('2026-06-10T10:00:00.000Z')
    const since = new Date(start).toISOString()
    expect(elapsed(since, start + 400)).toBeUndefined()
    expect(elapsed(since, start + 59_900)).toBe('59s')
    expect(elapsed(since, start + 65_000)).toBe('1m 5s')
    expect(elapsed(since, start + 2 * 3_600_000 + 61_000)).toBe('2h 1m')
    // Another clock ahead of this one: say nothing rather than a negative time.
    expect(elapsed(since, start - 5_000)).toBeUndefined()
    expect(elapsed(undefined, start)).toBeUndefined()
  })

  it('describes a routine’s next and last run in words', () => {
    const routine = {
      schedule: 'Weekdays at 07:30',
      enabled: true,
      nextRunAt: at(0, 19),
      lastRun: { at: at(1, 7), status: 'ok' as const },
    }
    expect(routineDetail(routine, now)).toBe(
      `Weekdays at 07:30 · next today at ${clockTime(at(0, 19))} · last run yesterday at ${clockTime(at(1, 7))}, succeeded`,
    )
    expect(
      routineDetail(
        { ...routine, enabled: false, lastRun: { at: at(1, 7), status: 'error' } },
        now,
      ),
    ).toBe(`Weekdays at 07:30 · last run yesterday at ${clockTime(at(1, 7))}, failed`)
    expect(
      routineDetail({ schedule: 'Hourly', enabled: true, nextRunAt: undefined }, now),
    ).toBe('Hourly')
  })
})

describe('shortcut hints in tooltips', () => {
  it('writes a shortcut as the platform does', () => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    expect(shortcutText('new-side')).toBe(mac ? '⌘⇧O' : 'Ctrl+Shift+O')
    expect(shortcutText('toggle-margin')).toBe(mac ? '⌘.' : 'Ctrl+.')
  })
})

describe('page title', () => {
  it('leads with what waits on the owner, as Work’s badge counts it', () => {
    expect(pageTitle(0, false)).toBe('Cindl')
    expect(pageTitle(2, false)).toBe('(2) Cindl')
    expect(pageTitle(12, false)).toBe('(9+) Cindl')
  })

  it('keeps the demo label in the demo', () => {
    const label = SYNTHETIC_DEMO_LABEL.toLowerCase()
    expect(pageTitle(0, true)).toBe(`Cindl (${label})`)
    expect(pageTitle(3, true)).toBe(`(3) Cindl (${label})`)
  })
})
