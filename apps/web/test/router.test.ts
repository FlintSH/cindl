import { describe, expect, it } from 'vitest'
import { formatRoute, parseRoute } from '../src/router.ts'

describe('hash routes', () => {
  it.each(['#/talk/%E0%A4%A', '#/library/skills/%', '#/agent/%ZZ'])(
    'falls back to Talk for a malformed escape %s instead of throwing',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ view: 'talk' })
    },
  )

  it.each([
    { view: 'talk', conversationId: '20260102_080000_ab12cd' },
    { view: 'work' },
    { view: 'library', section: 'skills', item: 'calendar-triage' },
    { view: 'agent', section: 'runtime' },
  ] as const)('round-trips %j', (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route)
  })

  it('treats unknown destinations and sections as defaults', () => {
    expect(parseRoute('#/nowhere')).toEqual({ view: 'talk' })
    expect(parseRoute('#/agent/nope')).toEqual({ view: 'agent', section: 'identity' })
    expect(parseRoute('#/library/nope')).toEqual({ view: 'library', section: 'skills' })
  })
})
