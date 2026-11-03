import { describe, expect, it } from 'vitest'
import {
  capabilityIds,
  cindlEventTypes,
  clientOps,
  CONTRACTS_VERSION,
  isOpName,
  opNames,
  parseOpArgs,
  ServerRequest,
  clarifyAnswersComplete,
  openQuestionIds,
} from '../src/index.ts'

describe('client operation registry', () => {
  it('declares a capability that exists for every gated operation', () => {
    for (const name of opNames) {
      const capability = (clientOps[name] as { capability?: string }).capability
      if (capability) expect(capabilityIds).toContain(capability)
    }
  })

  it('requires explicit confirmation for owner edits', () => {
    for (const name of [
      'skills.write',
      'soul.write',
      'routines.setEnabled',
      'display.acquireControl',
    ] as const) {
      const base =
        name === 'skills.write'
          ? { name: 'example', content: 'x', expectedVersion: 'a'.repeat(64) }
          : name === 'soul.write'
            ? { content: 'x', expectedVersion: 'a'.repeat(64) }
            : name === 'routines.setEnabled'
              ? { id: 'job-1', enabled: false }
              : {}
      expect(() => parseOpArgs(name, base)).toThrow()
      expect(() => parseOpArgs(name, { ...base, confirm: false })).toThrow()
      expect(parseOpArgs(name, { ...base, confirm: true })).toMatchObject({
        confirm: true,
      })
    }
  })

  it('rejects edits without the version that was reviewed', () => {
    expect(() =>
      parseOpArgs('soul.write', {
        content: 'x',
        expectedVersion: 'stale',
        confirm: true,
      }),
    ).toThrow()
  })

  it('rejects unknown operations and does not offer a passthrough', () => {
    expect(isOpName('shell.exec')).toBe(false)
    expect(isOpName('toString')).toBe(false)
    expect(() => parseOpArgs('rpc.call' as never, {})).toThrow(/Unknown Cindl operation/)
    expect(opNames.some((name) => /exec|vault|passthrough|raw/i.test(name))).toBe(false)
  })

  it('only answers approvals with Hermes choices, never approve-all', () => {
    expect(() =>
      parseOpArgs('request.answer', {
        requestId: 'srq-0123456789ab',
        answer: { kind: 'approval', choice: 'always' },
      }),
    ).toThrow()
    expect(ServerRequest.shape.choices.element.options).toEqual(['once', 'deny'])
  })

  it('keys server requests by the Hermes request id string only', () => {
    expect(
      parseOpArgs('request.answer', {
        requestId: 'srq-0123456789ab',
        answer: { kind: 'approval', choice: 'deny' },
      }),
    ).toMatchObject({ requestId: 'srq-0123456789ab' })
    for (const requestId of [
      7,
      '',
      '../x',
      'srq 1',
      'a?b',
      '#x',
      'srq-demo0000000z',
      'SRQ-0123456789AB',
      'srq-0123456789abc',
    ])
      expect(() =>
        parseOpArgs('request.answer', {
          requestId,
          answer: { kind: 'approval', choice: 'deny' },
        }),
      ).toThrow()
  })

  it('answers a clarify set in one submission with per-question responses', () => {
    const parsed = parseOpArgs('request.answer', {
      requestId: 'srq-0123456789ab',
      answer: {
        kind: 'clarify',
        answers: {
          q1: { text: 'Friday' },
          q2: { choices: ['A', 'B'] },
          q3: { skipped: true },
        },
      },
    })
    expect(parsed.answer).toMatchObject({ kind: 'clarify' })
    expect(() =>
      parseOpArgs('request.answer', {
        requestId: 'srq-0123456789ab',
        answer: { kind: 'clarify', answers: { q1: { text: '   ' } } },
      }),
    ).toThrow()
  })

  it('checks that a clarify submission covers every question exactly once', () => {
    const request = {
      questions: [
        { qid: 'q1', question: 'A?', multiSelect: false },
        { qid: 'q2', question: 'B?', multiSelect: true },
      ],
    }
    expect(
      clarifyAnswersComplete(request, { q1: { text: 'x' }, q2: { skipped: true } }),
    ).toBe(true)
    expect(clarifyAnswersComplete(request, { q1: { text: 'x' } })).toBe(false)
    expect(
      clarifyAnswersComplete(request, {
        q1: { text: 'x' },
        q2: { skipped: true },
        q3: { skipped: true },
      }),
    ).toBe(false)
    expect(clarifyAnswersComplete({ questions: [] }, {})).toBe(false)
  })

  it('leaves questions another client locked out of the submission', () => {
    const request = {
      questions: [
        { qid: 'q1', question: 'A?', multiSelect: false },
        { qid: 'q2', question: 'B?', multiSelect: false },
      ],
      lockedAnswers: { q1: { text: 'answered on the desktop app' } },
    }
    expect(openQuestionIds(request)).toEqual(['q2'])
    expect(clarifyAnswersComplete(request, { q2: { skipped: true } })).toBe(true)
    // Including a locked question would override the other client's answer.
    expect(
      clarifyAnswersComplete(request, { q1: { skipped: true }, q2: { skipped: true } }),
    ).toBe(false)
    expect(
      clarifyAnswersComplete(
        { ...request, lockedAnswers: { q1: { skipped: true }, q2: { text: 'x' } } },
        {},
      ),
    ).toBe(false)
  })
})

describe('sign-in origin', () => {
  it.each([
    ['https://hermes.example.test', 'https://hermes.example.test'],
    ['https://hermes.example.test/', 'https://hermes.example.test'],
    ['https://hermes.example.test:8443', 'https://hermes.example.test:8443'],
    ['http://127.0.0.1:9119', 'http://127.0.0.1:9119'],
    ['http://[::1]:9119/', 'http://[::1]:9119'],
  ])('accepts %s', (origin, normalised) => {
    expect(parseOpArgs('auth.signIn', { origin })).toEqual({ origin: normalised })
  })

  it.each([
    'https://hermes.example.test.',
    'https://hermes.example.test:0',
    'http://hermes.example.test',
    'http://localhost:9119',
    'http://10.0.2.2:9119',
    'https://user:pw@hermes.example.test',
    'https://hermes.example.test/path',
    'https://hermes.example.test/?q=1',
    'https://hermes.example.test/#f',
    'https://hermes.example.test#',
    'ftp://hermes.example.test',
    'javascript:alert(1)',
    'hermes.example.test',
    'https://hermes.example.test\\@evil.example.test',
    ' https://hermes.example.test',
  ])('rejects %j', (origin) => {
    expect(() => parseOpArgs('auth.signIn', { origin })).toThrow()
  })
})

describe('identifiers', () => {
  it('accepts Hermes-shaped ids and names', () => {
    expect(
      parseOpArgs('conversations.history', { conversationId: '20260102_080000_ab12cd' }),
    ).toBeTruthy()
    expect(parseOpArgs('soul.read', { profile: 'default' })).toBeTruthy()
    expect(parseOpArgs('skills.read', { name: 'calendar-triage' })).toBeTruthy()
    expect(parseOpArgs('skills.read', { name: 'Ops/Inventory sheets' })).toBeTruthy()
  })

  it.each(['../../etc', 'a/b', '%2e%2e', 'x?y=1#z', 'Default', '-lead', ''])(
    'rejects hostile profile %j',
    (profile) => {
      expect(() => parseOpArgs('soul.read', { profile })).toThrow()
    },
  )

  it.each(['../x?y=1#z', 'a/b/c', '..', ' lead', 'trail ', 'a?b', '%2e%2e', 'tab\there'])(
    'rejects hostile skill name %j',
    (name) => {
      expect(() => parseOpArgs('skills.read', { name })).toThrow()
    },
  )

  it.each(['../x', 'a/b', 'a?b', '#x', ''])(
    'rejects hostile conversation id %j',
    (conversationId) => {
      expect(() => parseOpArgs('conversations.history', { conversationId })).toThrow()
    },
  )

  it('treats inherited object keys as unknown operations', () => {
    for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty'])
      expect(() => parseOpArgs(name as never, {})).toThrow(/Unknown Cindl operation/)
  })
})

describe('contract surface', () => {
  it('is versioned and enumerable for docs coverage', () => {
    expect(CONTRACTS_VERSION).toBe(3)
    expect(new Set(cindlEventTypes).size).toBe(cindlEventTypes.length)
    expect(new Set(capabilityIds).size).toBe(capabilityIds.length)
  })
})
