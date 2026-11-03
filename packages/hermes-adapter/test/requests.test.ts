import { CindlError, ServerRequest } from '@cindl/contracts'
import { HermesContract } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { answerResult, mapServerRequest } from '../src/index.ts'

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
    expect(invalid(() => answerResult(denyOnly, { kind: 'clarify-cancel' }))).toBe(
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

  it('declines the whole set with an empty result', () => {
    expect(result(clarify(questions), { kind: 'clarify-cancel' })).toEqual({})
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

  it('does not map malformed frames', () => {
    expect(
      mapServerRequest({
        requestId: 'srq-1',
        method: 'clarify',
        params: { session_id: 's', questions: [] },
        lastSeenEpoch: 1,
        receivedAt,
      }),
    ).toBeUndefined()
    expect(
      mapServerRequest({
        requestId: 'srq-1',
        method: 'sudo',
        params: { session_id: 's' },
        lastSeenEpoch: 1,
        receivedAt,
      }),
    ).toBeUndefined()
  })
})
