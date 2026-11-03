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
  assertAnswerable,
  clarifyAnswersComplete,
  CindlError,
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

  it('edits and deletes memory entries only by current fingerprinted id, with confirmation', () => {
    const id = 'memory:memory:3:0a1b2c3d4e5f'
    for (const [name, base] of [
      ['memory.write', { id, content: 'Glaze calls move to Thursdays.' }],
      ['memory.delete', { id }],
    ] as const) {
      expect(() => parseOpArgs(name, base)).toThrow()
      expect(() => parseOpArgs(name, { ...base, confirm: false })).toThrow()
      expect(parseOpArgs(name, { ...base, confirm: true })).toMatchObject({
        id,
        confirm: true,
      })
    }
    for (const bad of [
      'memory:memory:3', // positional: may point at another entry after any change
      'memory:memory:3:0A1B2C3D4E5F',
      'memory:skills:3:0a1b2c3d4e5f',
      'skill:calendar-triage',
      '../memory:memory:3:0a1b2c3d4e5f',
    ])
      expect(() => parseOpArgs('memory.read', { id: bad })).toThrow(CindlError)
    expect(() =>
      parseOpArgs('memory.write', { id, content: '   ', confirm: true }),
    ).toThrow(CindlError)
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
    expect(() => parseOpArgs('rpc.call' as never, {})).toThrow(
      'Not sent: unknown operation.',
    )
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
      expect(() => parseOpArgs(name as never, {})).toThrow('Not sent: unknown operation.')
  })
})

describe('validation failures', () => {
  const failure = (run: () => unknown) => {
    try {
      run()
    } catch (err) {
      return err
    }
    throw new Error('expected a validation failure')
  }

  it('are CindlError invalid, say nothing was sent, and never echo the value', () => {
    const secretish = 'x'.repeat(100_001)
    const err = failure(() =>
      parseOpArgs('prompt.submit', {
        conversationId: 'c1',
        clientId: 'p1',
        text: secretish,
      }),
    )
    expect(err).toBeInstanceOf(CindlError)
    expect(err).toMatchObject({
      code: 'invalid',
      message: 'Not sent: the text is longer than 100,000 characters.',
      detail: 'prompt.submit: text too_big',
    })
    expect(JSON.stringify(err)).not.toContain('xxxx')
    expect(
      failure(() => parseOpArgs('request.answer', { requestId: 'nope' })),
    ).toMatchObject({
      code: 'invalid',
      message: 'Not sent: Cindl rejected this request before sending it.',
    })
  })

  it('accept every clarify choice Hermes can offer (8,000 characters plus a suffix)', () => {
    const offered = `${'c'.repeat(8_000)} (Recommended)`
    const answer = (choice: string) => ({
      requestId: 'srq-00000000000a',
      answer: { kind: 'clarify', answers: { q0: { choices: [choice] } } },
    })
    expect(parseOpArgs('request.answer', answer(offered))).toBeTruthy()
    expect(() => parseOpArgs('request.answer', answer('c'.repeat(16_385)))).toThrow(
      'Not sent: the text is longer than 16,384 characters.',
    )
  })
})

describe('server request shape (v4)', () => {
  const base = {
    requestId: 'srq-00000000000a',
    lastSeenEpoch: 1,
    kind: 'approval',
    conversationId: 'c1',
    title: 'Run a command',
    choices: ['once', 'deny'],
    receivedAt: '2026-01-01T00:00:00.000Z',
    status: 'open',
  }

  it('belongs to a conversation, except an app-level prompt Cindl never answers', () => {
    const { conversationId: _omit, ...withoutConversation } = base
    expect(ServerRequest.safeParse(withoutConversation).success).toBe(false)
    expect(ServerRequest.safeParse({ ...base, conversationId: '' }).success).toBe(false)
    expect(
      ServerRequest.safeParse({
        ...withoutConversation,
        kind: 'unsupported',
        unsupportedKind: 'sudo',
        choices: [],
      }).success,
    ).toBe(true)
  })

  it('has no clarify decline: an empty reply reads like an interrupt to the agent', () => {
    expect(() =>
      parseOpArgs('request.answer', {
        requestId: 'srq-00000000000a',
        answer: { kind: 'clarify-cancel' },
      }),
    ).toThrow(CindlError)
  })

  it('represents prompts Cindl does not answer', () => {
    for (const unsupportedKind of ['sudo', 'secret', 'vault', 'other'])
      expect(
        ServerRequest.safeParse({
          ...base,
          kind: 'unsupported',
          unsupportedKind,
          choices: [],
        }).success,
      ).toBe(true)
    expect(
      ServerRequest.safeParse({
        ...base,
        kind: 'unsupported',
        unsupportedKind: 'password',
      }).success,
    ).toBe(false)
  })

  it('refuses a question id that a record would silently drop', () => {
    const question = (qid: string) => ({
      ...base,
      kind: 'clarify',
      choices: [],
      questions: [{ qid, question: 'Which?', multiSelect: false }],
    })
    expect(ServerRequest.safeParse(question('q0')).success).toBe(true)
    expect(ServerRequest.safeParse(question('constructor')).success).toBe(true)
    expect(ServerRequest.safeParse(question('__proto__')).success).toBe(false)
    // An answer keyed `__proto__` can only target a question no request has:
    // validation drops it without touching any prototype.
    const parsed = parseOpArgs('request.answer', {
      requestId: 'srq-00000000000a',
      answer: {
        kind: 'clarify',
        answers: JSON.parse('{"__proto__": {"skipped": true}}') as unknown,
      },
    })
    const answers = (parsed.answer as { answers: object }).answers
    expect(Object.hasOwn(answers, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype)
  })

  it('gives a prompt Cindl does not answer nothing to answer, and refuses answers to it', () => {
    const sudo = { ...base, kind: 'unsupported', unsupportedKind: 'sudo', choices: [] }
    expect(ServerRequest.safeParse(sudo).success).toBe(true)
    expect(ServerRequest.safeParse({ ...sudo, choices: ['once'] }).success).toBe(false)
    expect(
      ServerRequest.safeParse({
        ...sudo,
        questions: [{ qid: 'q0', question: 'Password?', multiSelect: false }],
      }).success,
    ).toBe(false)
    expect(() => assertAnswerable({ kind: 'unsupported' })).toThrow(CindlError)
    expect(() => assertAnswerable({ kind: 'approval' })).not.toThrow()
  })

  it('accepts every choice Hermes can offer even in astral characters', () => {
    // 8,000 emoji plus the suffix: 8,014 code points, 16,014 UTF-16 units.
    const offered = `${'\u{1F525}'.repeat(8_000)} (Recommended)`
    expect(
      parseOpArgs('request.answer', {
        requestId: 'srq-00000000000a',
        answer: { kind: 'clarify', answers: { q0: { choices: [offered] } } },
      }),
    ).toBeTruthy()
  })

  it('accepts any locked answer Hermes reports, however long', () => {
    const request = ServerRequest.parse({
      ...base,
      kind: 'clarify',
      choices: [],
      questions: [{ qid: 'q0', question: 'Notes?', multiSelect: false }],
      lockedAnswers: { q0: { text: 'n'.repeat(30_000) } },
    })
    expect(openQuestionIds(request)).toEqual([])
  })
})

describe('contract surface', () => {
  it('is versioned and enumerable for docs coverage', () => {
    expect(CONTRACTS_VERSION).toBe(4)
    expect(new Set(cindlEventTypes).size).toBe(cindlEventTypes.length)
    expect(new Set(capabilityIds).size).toBe(capabilityIds.length)
  })
})
