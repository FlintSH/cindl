// @vitest-environment node
import { SYNTHETIC_DEMO_LABEL } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { pageTitle } from '../src/shell/title.ts'
import { clockTime, momentInSentence } from '../src/talk/format.ts'

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
