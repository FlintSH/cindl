// @vitest-environment node
import type { Conversation, MessagePart } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { longAgo, rowStatus, shelvesOf, shortAgo } from '../src/talk/conversationList.ts'
import {
  segmentsOf,
  startsOpen,
  summarize,
  type StepFacts,
} from '../src/talk/workGroups.ts'

const conversation = (over: Partial<Conversation>): Conversation => ({
  id: 'c',
  session: { storedId: 's' },
  title: 'Untitled',
  kind: 'side',
  status: 'idle',
  ...over,
})

describe('the conversation list', () => {
  const list = [
    conversation({ id: 'main', kind: 'main', title: 'Today', status: 'waiting-on-you' }),
    conversation({ id: 'kiln', title: 'Kiln sheet', status: 'waiting-on-you' }),
    conversation({ id: 'trip', title: 'Studio trip', status: 'working' }),
    conversation({ id: 'old', title: 'Old notes', preview: 'glaze batches' }),
  ]

  it('pins the main conversation, then what needs you, then the rest in order', () => {
    expect(shelvesOf(list).map((s) => [s.id, s.conversations.map((c) => c.id)])).toEqual([
      ['pinned', ['main']],
      ['needs-you', ['kiln']],
      ['recent', ['trip', 'old']],
    ])
  })

  it('searches titles and previews, and drops empty shelves', () => {
    expect(shelvesOf(list, 'glaze').map((s) => s.id)).toEqual(['recent'])
    expect(shelvesOf(list, 'glaze')[0]?.conversations.map((c) => c.id)).toEqual(['old'])
    expect(shelvesOf(list, 'zzz')).toEqual([])
  })

  it('shows a status worth a glance in place of the time', () => {
    const now = Date.parse('2026-06-10T12:00:00.000Z')
    expect(rowStatus(list[1] as Conversation, now)).toEqual({
      kind: 'needs-you',
      label: 'Needs you',
    })
    expect(rowStatus(list[2] as Conversation, now)).toEqual({
      kind: 'working',
      label: 'Working',
    })
    expect(
      rowStatus(conversation({ updatedAt: '2026-06-10T11:55:00.000Z' }), now),
    ).toEqual({ kind: 'time', label: '5m', spoken: '5 minutes ago' })
    expect(rowStatus(conversation({}), now)).toEqual({ kind: 'none', label: '' })
  })

  it('names what the owner must answer, approvals first, and counts them past one', () => {
    const waiting = list[1] as Conversation
    expect(rowStatus(waiting, 0, { requests: [{ kind: 'approval' }] })).toEqual({
      kind: 'approval',
      label: 'Approval',
    })
    expect(rowStatus(waiting, 0, { requests: [{ kind: 'clarify' }] })).toEqual({
      kind: 'question',
      label: 'Question',
    })
    expect(
      rowStatus(waiting, 0, { requests: [{ kind: 'clarify' }, { kind: 'approval' }] }),
    ).toEqual({ kind: 'approval', label: '2 need you' })
    // A prompt Cindl never answers still needs the owner, elsewhere.
    expect(rowStatus(waiting, 0, { requests: [{ kind: 'unsupported' }] })).toEqual({
      kind: 'needs-you',
      label: 'Needs you',
    })
  })

  it('marks what finished unseen as Done, below what needs you or works', () => {
    const idle = conversation({ updatedAt: '2026-06-10T11:00:00.000Z' })
    expect(rowStatus(idle, 0, { finished: true })).toMatchObject({ kind: 'done' })
    expect(rowStatus(list[2] as Conversation, 0, { finished: true }).kind).toBe('working')
    expect(
      rowStatus(list[1] as Conversation, 0, { finished: true, requests: [] }).kind,
    ).toBe('needs-you')
  })

  it('says ages in full for a screen reader', () => {
    const now = Date.parse('2026-06-10T12:00:00.000Z')
    const ago = (ms: number) => longAgo(new Date(now - ms).toISOString(), now)
    expect(ago(20_000)).toBe('just now')
    expect(ago(60_000)).toBe('1 minute ago')
    expect(ago(3 * 3_600_000)).toBe('3 hours ago')
    expect(ago(86_400_000)).toBe('1 day ago')
    expect(ago(400 * 86_400_000)).toMatch(/2025/)
  })

  it('writes short ages: now, minutes, hours, days, then the date', () => {
    const now = Date.parse('2026-06-10T12:00:00.000Z')
    const ago = (ms: number) => shortAgo(new Date(now - ms).toISOString(), now)
    expect(ago(20_000)).toBe('now')
    expect(ago(-60_000)).toBe('now')
    expect(ago(5 * 60_000)).toBe('5m')
    expect(ago(3 * 3_600_000)).toBe('3h')
    expect(ago(2 * 86_400_000)).toBe('2d')
    expect(ago(30 * 86_400_000)).not.toMatch(/2026/)
    expect(ago(400 * 86_400_000)).toMatch(/2025/)
    expect(shortAgo('not a date', now)).toBeUndefined()
  })
})

describe('the work log', () => {
  const tool = (toolId: string): MessagePart => ({ type: 'tool', toolId })
  const text = (t: string): MessagePart => ({ type: 'text', text: t })

  it('folds two or more consecutive steps into one group; a lone step stays a step', () => {
    const segments = segmentsOf([tool('a'), tool('b'), text('x'), tool('c'), text('y')])
    expect(segments.map((s) => (s.kind === 'work' ? s.toolIds : s.part.type))).toEqual([
      ['a', 'b'],
      'text',
      'tool',
      'text',
    ])
    expect(segments[0]).toMatchObject({ kind: 'work', key: 'a' })
  })

  const step = (over: Partial<StepFacts>): StepFacts => ({
    status: 'complete',
    startedAt: '2026-06-10T10:00:00.000Z',
    endedAt: '2026-06-10T10:00:12.000Z',
    blocked: false,
    ...over,
  })

  it('reads as one line once every step is done, with the span they took', () => {
    const summary = summarize([
      step({}),
      step({
        startedAt: '2026-06-10T10:00:20.000Z',
        endedAt: '2026-06-10T10:01:05.000Z',
      }),
    ])
    expect(summary).toMatchObject({ label: '2 steps', settled: true, took: '1m 5s' })
    expect(startsOpen(summary)).toBe(false)
  })

  it('stays open while working, waiting on the owner, or holding a failure', () => {
    const live = summarize([step({}), step({ status: 'running', endedAt: undefined })])
    expect(live).toMatchObject({ live: 1, settled: false, took: undefined })
    expect(startsOpen(live)).toBe(true)
    const blocked = summarize([
      step({}),
      step({ status: 'running', endedAt: undefined, blocked: true }),
    ])
    expect(blocked).toMatchObject({ live: 0, blocked: 1 })
    expect(startsOpen(blocked)).toBe(true)
    const failed = summarize([step({}), step({ status: 'error' })])
    expect(failed.label).toBe('2 steps, 1 failed')
    expect(startsOpen(failed)).toBe(true)
  })
})
