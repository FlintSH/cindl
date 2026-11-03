import { CindlError, ServerRequest } from '@cindl/contracts'
import { HermesContract } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { answerResult, mapServerRequest, mapUnsupportedRequest } from '../src/index.ts'

const contract = new HermesContract()
const receivedAt = '2026-06-02T08:00:00.000Z'

function approval(params: Record<string, unknown>) {
  const full = { session_id: 'a1b2c3d4', request_id: 'f'.repeat(32), ...params }
  expect(contract.serverRequestParams('approval', full).errors).toEqual([])
  const mapped = mapServerRequest({
    requestId: 'srq-0123456789ab',
    method: 'approval',
    params: full,
    lastSeenEpoch: 3,
    receivedAt,
    conversationId: 'c1',
  })
  if (!mapped) throw new Error('not mapped')
  return ServerRequest.parse(mapped.request)
}

function clarify(questions: Array<Record<string, unknown>>) {
  const params = { session_id: 'a1b2c3d4', questions }
  expect(contract.serverRequestParams('clarify', params).errors).toEqual([])
  const mapped = mapServerRequest({
    requestId: 'srq-0000000000cd',
    method: 'clarify',
    params,
    lastSeenEpoch: 1,
    receivedAt,
    conversationId: 'c1',
  })
  if (!mapped) throw new Error('not mapped')
  return ServerRequest.parse(mapped.request)
}

const result = (request: ServerRequest, answer: Parameters<typeof answerResult>[1]) => {
  const value = answerResult(request, answer)
  expect(
    contract.serverRequestResult(request.kind, value).errors,
    'Cindl answers must match the vendored result schema',
  ).toEqual([])
  return value
}

const invalid = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return (error as CindlError).code
  }
  return 'accepted'
}

describe('approval requests', () => {
  it('offers only once and deny, names what it withholds and keeps Hermes ids', () => {
    const request = approval({
      command: 'rm -rf /srv/hermes-fixture/tmp',
      description: 'Delete the synthetic temp folder',
      choices: ['once', 'session', 'always', 'deny'],
      tool_name: 'terminal',
    })
    expect(request).toMatchObject({
      requestId: 'srq-0123456789ab',
      hermesApprovalId: 'f'.repeat(32),
      lastSeenEpoch: 3,
      kind: 'approval',
      choices: ['once', 'deny'],
      withheldChoices: ['session', 'always'],
      command: 'rm -rf /srv/hermes-fixture/tmp',
      toolName: 'terminal',
      status: 'open',
    })
  })

  it('derives Hermes defaults when choices are absent and respects smart denial', () => {
    expect(approval({}).withheldChoices).toEqual(['session', 'always'])
    expect(approval({ smart_denied: true }).withheldChoices).toBeUndefined()
    expect(approval({ allow_permanent: false }).withheldChoices).toEqual(['session'])
  })

  it('answers with an offered choice and never sends all', () => {
    const request = approval({ choices: ['once', 'session', 'always', 'deny'] })
    expect(result(request, { kind: 'approval', choice: 'once' })).toEqual({
      choice: 'once',
    })
    expect(result(request, { kind: 'approval', choice: 'deny' })).toEqual({
      choice: 'deny',
    })
  })

  it('rejects a choice Hermes did not offer and answers of the wrong kind', () => {
    const denyOnly = approval({ choices: ['deny'] })
    expect(denyOnly.choices).toEqual(['deny'])
    expect(
      invalid(() => answerResult(denyOnly, { kind: 'approval', choice: 'once' })),
    ).toBe('invalid')
    expect(invalid(() => answerResult(denyOnly, { kind: 'clarify', answers: {} }))).toBe(
      'invalid',
    )
  })

  it('redacts credentials Hermes did not catch in the command', () => {
    const request = approval({
      command:
        'curl -H "Authorization: Bearer abcdefghijklmnopqrstu" https://example.test',
    })
    expect(request.command).not.toContain('abcdefghijklmnopqrstu')
  })
})

describe('clarify requests', () => {
  const questions = [
    {
      qid: 'q0',
      question: 'Which venue? (fixture)',
      choices: ['North hall (Recommended)', 'South hall'],
      multi_select: false,
    },
    {
      qid: 'q1',
      question: 'Which days? (fixture)',
      choices: ['Mon', 'Tue', 'Wed'],
      multi_select: true,
    },
    { qid: 'q2', question: 'Anything else? (fixture)' },
  ]

  it('maps questions and encodes one reply for the whole set', () => {
    const request = clarify(questions)
    expect(request.questions).toEqual([
      {
        qid: 'q0',
        question: 'Which venue? (fixture)',
        choices: ['North hall (Recommended)', 'South hall'],
        multiSelect: false,
      },
      {
        qid: 'q1',
        question: 'Which days? (fixture)',
        choices: ['Mon', 'Tue', 'Wed'],
        multiSelect: true,
      },
      { qid: 'q2', question: 'Anything else? (fixture)', multiSelect: false },
    ])
    expect(
      result(request, {
        kind: 'clarify',
        answers: {
          q0: { choices: ['North hall (Recommended)'] },
          q1: { choices: ['Mon', 'Wed'] },
          q2: { skipped: true },
        },
      }),
    ).toEqual({
      answers: { q0: 'North hall (Recommended)', q1: '["Mon","Wed"]', q2: null },
    })
    expect(
      result(request, {
        kind: 'clarify',
        answers: {
          q0: { text: 'The rooftop' },
          q1: { text: 'Fridays' },
          q2: { text: 'No' },
        },
      }),
    ).toEqual({ answers: { q0: 'The rooftop', q1: 'Fridays', q2: 'No' } })
  })

  it('skips the whole set by skipping every open question, never with an empty reply', () => {
    expect(
      result(clarify(questions), {
        kind: 'clarify',
        answers: { q0: { skipped: true }, q1: { skipped: true }, q2: { skipped: true } },
      }),
    ).toEqual({ answers: { q0: null, q1: null, q2: null } })
  })

  it('requires every question, offered options and one option for a single select', () => {
    const request = clarify(questions)
    const partial = { q0: { skipped: true as const }, q1: { skipped: true as const } }
    expect(
      invalid(() => answerResult(request, { kind: 'clarify', answers: partial })),
    ).toBe('invalid')
    expect(
      invalid(() =>
        answerResult(request, {
          kind: 'clarify',
          answers: { ...partial, q2: { skipped: true }, extra: { skipped: true } },
        }),
      ),
    ).toBe('invalid')
    expect(
      invalid(() =>
        answerResult(request, {
          kind: 'clarify',
          answers: {
            q0: { choices: ['Basement'] },
            q1: { skipped: true },
            q2: { skipped: true },
          },
        }),
      ),
    ).toBe('invalid')
    expect(
      invalid(() =>
        answerResult(request, {
          kind: 'clarify',
          answers: {
            q0: { choices: ['North hall (Recommended)', 'South hall'] },
            q1: { skipped: true },
            q2: { skipped: true },
          },
        }),
      ),
    ).toBe('invalid')
  })

  it('carries answers other clients locked and leaves those questions to them', () => {
    const params = {
      session_id: 'a1b2c3d4',
      questions,
      answers: { q0: 'South hall', q1: '["Tue","Wed"]', gone: 'stale lock' },
    }
    expect(contract.serverRequestParams('clarify', params).errors).toEqual([])
    const mapped = mapServerRequest({
      requestId: 'srq-0000000000ce',
      method: 'clarify',
      params,
      lastSeenEpoch: 2,
      receivedAt,
      conversationId: 'c1',
    })
    const request = ServerRequest.parse(mapped?.request)
    expect(request.lockedAnswers).toEqual({
      q0: { choices: ['South hall'] },
      q1: { choices: ['Tue', 'Wed'] },
    })
    // Only q2 is open, so the reply carries q2 alone and cannot override a lock.
    expect(result(request, { kind: 'clarify', answers: { q2: { text: 'No' } } })).toEqual(
      {
        answers: { q2: 'No' },
      },
    )
    expect(
      invalid(() =>
        answerResult(request, {
          kind: 'clarify',
          answers: { q0: { choices: ['North hall (Recommended)'] }, q2: { text: 'No' } },
        }),
      ),
    ).toBe('invalid')
  })

  it('maps skipped and typed locks, and leaves nothing to send when all are locked', () => {
    const params = {
      session_id: 'a1b2c3d4',
      questions,
      answers: { q0: 'The rooftop', q1: null, q2: '' },
    }
    expect(contract.serverRequestParams('clarify', params).errors).toEqual([])
    const request = ServerRequest.parse(
      mapServerRequest({
        requestId: 'srq-0000000000cf',
        method: 'clarify',
        params,
        lastSeenEpoch: 2,
        receivedAt,
        conversationId: 'c1',
      })?.request,
    )
    expect(request.lockedAnswers).toEqual({
      q0: { text: 'The rooftop' },
      q1: { skipped: true },
      q2: { skipped: true },
    })
    expect(invalid(() => answerResult(request, { kind: 'clarify', answers: {} }))).toBe(
      'invalid',
    )
  })

  it('maps only ids in the srq-<12 hex> form Hermes mints', () => {
    const params = { session_id: 'a1b2c3d4', questions }
    for (const requestId of [
      'srq-1',
      'srq-0123456789AB',
      'srq-0123456789abc',
      'req-0123456789ab',
      'srq-0123456789ab ',
    ])
      expect(
        mapServerRequest({
          requestId,
          method: 'clarify',
          params,
          lastSeenEpoch: 1,
          receivedAt,
          conversationId: 'c1',
        }),
      ).toBeUndefined()
  })

  it('does not map malformed frames', () => {
    expect(
      mapServerRequest({
        requestId: 'srq-1',
        method: 'clarify',
        params: { session_id: 's', questions: [] },
        lastSeenEpoch: 1,
        receivedAt,
        conversationId: 'c1',
      }),
    ).toBeUndefined()
    expect(
      mapServerRequest({
        requestId: 'srq-1',
        method: 'sudo',
        params: { session_id: 's' },
        lastSeenEpoch: 1,
        receivedAt,
        conversationId: 'c1',
      }),
    ).toBeUndefined()
  })
})

describe('requests Cindl never answers', () => {
  const unsupported = (method: string, sessionId = 'a1b2c3d4') =>
    mapUnsupportedRequest({
      requestId: 'srq-00000000beef',
      method,
      sessionId,
      lastSeenEpoch: 2,
      receivedAt,
      conversationId: 'c1',
    })

  it('shows what Hermes wants and nothing from its params', () => {
    const titles = Object.fromEntries(
      ['sudo', 'display.install.sudo', 'secret', 'vault.code', 'setup_beat'].map(
        (method) => {
          const request = ServerRequest.parse(unsupported(method)?.request)
          expect(request).toMatchObject({
            kind: 'unsupported',
            conversationId: 'c1',
            status: 'open',
            choices: [],
            lastSeenEpoch: 2,
          })
          expect(Object.keys(request).sort()).toEqual([
            'choices',
            'conversationId',
            'kind',
            'lastSeenEpoch',
            'receivedAt',
            'requestId',
            'status',
            'title',
            'unsupportedKind',
          ])
          return [method, [request.unsupportedKind, request.title]]
        },
      ),
    )
    expect(titles).toEqual({
      sudo: ['sudo', 'Hermes is asking for a sudo password'],
      'display.install.sudo': ['sudo', 'Hermes is asking for a sudo password'],
      secret: ['secret', 'Hermes is asking for a secret'],
      'vault.code': ['vault', 'Hermes is asking for a password-manager password or code'],
      setup_beat: [
        'other',
        'Hermes is waiting for input Cindl does not handle (setup_beat)',
      ],
    })
  })

  it('maps an app-level prompt without a conversation, and nothing without a request id', () => {
    const appLevel = mapUnsupportedRequest({
      requestId: 'srq-00000000beef',
      method: 'display.install.sudo',
      sessionId: '',
      lastSeenEpoch: 2,
      receivedAt,
    })
    expect(ServerRequest.parse(appLevel?.request)).toMatchObject({
      kind: 'unsupported',
      unsupportedKind: 'sudo',
      status: 'open',
    })
    expect(appLevel?.request.conversationId).toBeUndefined()
    // A session-scoped prompt needs its conversation (the caller resolves it first).
    expect(
      mapUnsupportedRequest({
        requestId: 'srq-00000000beef',
        method: 'sudo',
        sessionId: 'a1b2c3d4',
        lastSeenEpoch: 1,
        receivedAt,
      }),
    ).toBeUndefined()
    expect(
      mapUnsupportedRequest({
        requestId: 'srq-1',
        method: 'sudo',
        sessionId: 'a1b2c3d4',
        lastSeenEpoch: 1,
        receivedAt,
        conversationId: 'c1',
      }),
    ).toBeUndefined()
  })

  it('refuses to build an answer for one', () => {
    const request = ServerRequest.parse(unsupported('secret')?.request)
    expect(
      invalid(() => answerResult(request, { kind: 'approval', choice: 'deny' })),
    ).toBe('unsupported')
  })
})
