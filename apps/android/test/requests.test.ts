import {
  clarifyAnswersComplete,
  clientOps,
  type CindlClientApi,
  type ClarifyQuestion,
  type ServerRequest,
} from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  answerArgs,
  answerOnce,
  buildClarifyAnswer,
  chooseOther,
  clarifyDraftStore,
  describeResponse,
  draftFor,
  emptyDraft,
  isQuickQuestion,
  pickChoice,
  requestKeyOf,
  requestNoun,
  responseFor,
  sendAnswer,
  setSkipped,
  skipAllAnswer,
  splitQuestions,
  typeAnswer,
  unsupportedCopy,
  withDraft,
  type ClarifyDrafts,
} from '../src/talk/requests.ts'

const venue: ClarifyQuestion = {
  qid: 'venue',
  question: 'Which venue?',
  choices: ['Harbor Loft (fictional)', 'Orchard Barn (fictional)'],
  multiSelect: false,
}
const glazes: ClarifyQuestion = {
  qid: 'glazes',
  question: 'Which glazes?',
  choices: ['Celadon', 'Tenmoku', 'Shino'],
  multiSelect: true,
}
const notes: ClarifyQuestion = {
  qid: 'notes',
  question: 'Anything else?',
  multiSelect: false,
}

const clarify = (overrides: Partial<ServerRequest> = {}): ServerRequest => ({
  requestId: 'srq-00000000dea2',
  lastSeenEpoch: 1,
  kind: 'clarify',
  title: 'A few questions',
  choices: [],
  questions: [venue, glazes, notes],
  receivedAt: '2026-06-02T08:00:00.000Z',
  status: 'open',
  ...overrides,
})

describe('a question draft never discards what the owner typed or picked', () => {
  it('keeps typed text when an option is picked, and both when skipping', () => {
    let draft = typeAnswer(venue, emptyDraft, 'The loft, if the kiln fits')
    expect(draft).toMatchObject({ other: 'The loft, if the kiln fits', useOther: true })
    draft = pickChoice(venue, draft, 'Orchard Barn (fictional)')
    expect(draft).toMatchObject({ other: 'The loft, if the kiln fits', useOther: false })
    expect(responseFor(venue, draft)).toEqual({ choices: ['Orchard Barn (fictional)'] })
    draft = chooseOther(draft)
    expect(responseFor(venue, draft)).toEqual({ text: 'The loft, if the kiln fits' })
    draft = setSkipped(draft, true)
    expect(responseFor(venue, draft)).toEqual({ skipped: true })
    draft = setSkipped(draft, false)
    expect(draft.other).toBe('The loft, if the kiln fits')
    expect(draft.selected).toEqual(['Orchard Barn (fictional)'])
  })

  it('single choice replaces; multi-select toggles and adds typed text as a choice', () => {
    expect(
      pickChoice(
        venue,
        pickChoice(venue, emptyDraft, 'Harbor Loft (fictional)'),
        'Orchard Barn (fictional)',
      ).selected,
    ).toEqual(['Orchard Barn (fictional)'])
    let draft = pickChoice(glazes, pickChoice(glazes, emptyDraft, 'Celadon'), 'Shino')
    draft = pickChoice(glazes, draft, 'Celadon')
    expect(draft.selected).toEqual(['Shino'])
    expect(responseFor(glazes, typeAnswer(glazes, draft, ' Ash glaze '))).toEqual({
      choices: ['Shino', 'Ash glaze'],
    })
    expect(
      responseFor(glazes, typeAnswer(glazes, emptyDraft, 'Only test tiles')),
    ).toEqual({
      text: 'Only test tiles',
    })
  })

  it('treats blank text as unanswered', () => {
    expect(responseFor(notes, typeAnswer(notes, emptyDraft, '   '))).toBeUndefined()
    expect(responseFor(venue, chooseOther(emptyDraft))).toBeUndefined()
  })
})

describe('one reply for the whole clarify set (contract v4)', () => {
  it('is only complete when every open question is answered or skipped', () => {
    const request = clarify()
    let drafts: ClarifyDrafts = withDraft(
      {},
      'venue',
      pickChoice(venue, emptyDraft, 'Harbor Loft (fictional)'),
    )
    expect(buildClarifyAnswer(request, drafts)).toBeUndefined()
    drafts = withDraft(drafts, 'glazes', pickChoice(glazes, emptyDraft, 'Celadon'))
    drafts = withDraft(drafts, 'notes', setSkipped(emptyDraft, true))
    const answer = buildClarifyAnswer(request, drafts)
    expect(answer).toEqual({
      kind: 'clarify',
      answers: {
        venue: { choices: ['Harbor Loft (fictional)'] },
        glazes: { choices: ['Celadon'] },
        notes: { skipped: true },
      },
    })
    expect(answer).toBeDefined()
    if (answer)
      expect(() =>
        clientOps['request.answer'].args.parse(answerArgs(request, answer)),
      ).not.toThrow()
  })

  it('skips every open question for "Skip all", never a locked one (no decline in v4)', () => {
    const request = clarify({ lockedAnswers: { glazes: { choices: ['Celadon'] } } })
    const answer = skipAllAnswer(request)
    expect(answer).toEqual({
      kind: 'clarify',
      answers: { venue: { skipped: true }, notes: { skipped: true } },
    })
    expect(
      answer.kind === 'clarify' && clarifyAnswersComplete(request, answer.answers),
    ).toBe(true)
    expect(() =>
      clientOps['request.answer'].args.parse(answerArgs(request, answer)),
    ).not.toThrow()
  })

  it('shows answers locked on another device and never sends them', () => {
    const request = clarify({
      lockedAnswers: { glazes: { choices: ['Tenmoku', 'Shino'] } },
    })
    const { open, locked } = splitQuestions(request)
    expect(open.map((q) => q.qid)).toEqual(['venue', 'notes'])
    expect(locked).toEqual([
      { question: glazes, response: { choices: ['Tenmoku', 'Shino'] } },
    ])
    expect(describeResponse(locked[0]?.response)).toBe('Tenmoku, Shino')
    const drafts = withDraft(
      withDraft(
        withDraft({}, 'venue', pickChoice(venue, emptyDraft, 'Harbor Loft (fictional)')),
        'notes',
        setSkipped(emptyDraft, true),
      ),
      'glazes',
      pickChoice(glazes, emptyDraft, 'Celadon'),
    )
    expect(buildClarifyAnswer(request, drafts)).toEqual({
      kind: 'clarify',
      answers: {
        venue: { choices: ['Harbor Loft (fictional)'] },
        notes: { skipped: true },
      },
    })
  })

  it('answers with one tap only for a single open single-choice question', () => {
    expect(isQuickQuestion([venue])).toBe(true)
    expect(isQuickQuestion([glazes])).toBe(false)
    expect(isQuickQuestion([notes])).toBe(false)
    expect(isQuickQuestion([venue, notes])).toBe(false)
    expect(
      isQuickQuestion(
        splitQuestions(
          clarify({
            questions: [venue, glazes],
            lockedAnswers: { glazes: { skipped: true } },
          }),
        ).open,
      ),
    ).toBe(true)
  })

  it('describes every kind of locked answer', () => {
    expect(describeResponse({ skipped: true })).toBe('skipped')
    expect(describeResponse({ text: 'Friday' })).toBe('Friday')
    expect(describeResponse(undefined)).toBe('unknown')
  })

  it('never reads an inherited property as a draft (question ids come from Hermes)', () => {
    const hostile: ClarifyQuestion = {
      qid: 'constructor',
      question: 'Odd id?',
      multiSelect: false,
    }
    expect(draftFor({}, 'constructor')).toBe(emptyDraft)
    expect(draftFor({}, 'toString')).toBe(emptyDraft)
    const drafts = withDraft({}, '__proto__', typeAnswer(notes, emptyDraft, 'kept'))
    expect(draftFor(drafts, '__proto__').other).toBe('kept')
    const request = clarify({ questions: [hostile] })
    expect(buildClarifyAnswer(request, {})).toBeUndefined()
    expect(
      buildClarifyAnswer(
        request,
        withDraft({}, 'constructor', typeAnswer(hostile, emptyDraft, 'yes')),
      ),
    ).toEqual({ kind: 'clarify', answers: { constructor: { text: 'yes' } } })
  })
})

describe('drafts survive a remount for the session', () => {
  it('stores drafts per request id', () => {
    const drafts = withDraft({}, 'notes', typeAnswer(notes, emptyDraft, 'Half typed'))
    clarifyDraftStore.save('srq-00000000beef', drafts)
    expect(clarifyDraftStore.load('srq-00000000beef')).toBe(drafts)
    expect(clarifyDraftStore.load('srq-000000000000')).toEqual({})
  })
})

describe('request identity', () => {
  const request: ServerRequest = {
    requestId: 'srq-00000000dea1',
    lastSeenEpoch: 3,
    kind: 'approval',
    title: 'Run the export',
    choices: ['once', 'deny'],
    receivedAt: '2026-06-02T08:00:00.000Z',
    status: 'open',
  }

  it('keys requests by Hermes request id, not by connection', () => {
    const seenAfterReconnect: ServerRequest = { ...request, lastSeenEpoch: 4 }
    expect(requestKeyOf(seenAfterReconnect)).toBe(requestKeyOf(request))
    expect(requestKeyOf(request)).toBe('srq-00000000dea1')
  })

  it('answers by request id with the chosen decision', () => {
    expect(answerArgs(request, { kind: 'approval', choice: 'deny' })).toEqual({
      requestId: 'srq-00000000dea1',
      answer: { kind: 'approval', choice: 'deny' },
    })
  })
})

describe('prompts Cindl never answers (contract v4)', () => {
  const sudo: ServerRequest = {
    requestId: 'srq-00000000dea3',
    lastSeenEpoch: 1,
    kind: 'unsupported',
    unsupportedKind: 'sudo',
    conversationId: 'demo-inventory',
    title: 'sudo password to restart the label printer (fictional)',
    choices: [],
    receivedAt: '2026-06-02T08:00:00.000Z',
    status: 'open',
  }
  const approval: ServerRequest = {
    ...sudo,
    requestId: 'srq-00000000dea1',
    kind: 'approval',
    unsupportedKind: undefined,
    title: 'Run the export',
    choices: ['once', 'deny'],
  }
  const recorder = () => {
    const calls: unknown[][] = []
    const api: Pick<CindlClientApi, 'call'> = {
      call: (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve(approval as never)
      },
    }
    return { api, calls }
  }

  it('sends nothing for them, not even a decline or an empty reply', async () => {
    const { api, calls } = recorder()
    await expect(
      sendAnswer(api, sudo, { kind: 'approval', choice: 'deny' }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    const appLevel: ServerRequest = { ...sudo, conversationId: undefined }
    await expect(
      sendAnswer(api, appLevel, { kind: 'clarify', answers: {} }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(calls).toEqual([])
    await sendAnswer(api, approval, { kind: 'approval', choice: 'once' })
    expect(calls).toEqual([
      [
        'request.answer',
        { requestId: 'srq-00000000dea1', answer: { kind: 'approval', choice: 'once' } },
      ],
    ])
  })

  it('says what Hermes waits for and where to answer it', () => {
    expect(unsupportedCopy(sudo)).toBe(
      'Hermes is waiting for a sudo password. Cindl never collects passwords, secrets or codes and sends nothing for this prompt. Answer it in another Hermes surface, such as the Hermes terminal. It stays open here until Hermes closes it.',
    )
    expect(unsupportedCopy({ unsupportedKind: 'secret' })).toMatch(
      /^Hermes is waiting for a secret value\./,
    )
    expect(unsupportedCopy({ unsupportedKind: 'vault' })).toMatch(
      /a vault password or code/,
    )
    expect(unsupportedCopy({})).toMatch(
      /^Hermes is waiting for an answer Cindl cannot send\. Cindl does not support this kind of prompt and sends nothing for it\./,
    )
    expect(requestNoun(sudo)).toBe('prompt to answer outside Cindl')
    expect(requestNoun(approval)).toBe('approval')
    expect(requestNoun({ kind: 'clarify' })).toBe('question')
  })
})

describe('the answer lock covers the call only (contract v4)', () => {
  it('sends one answer per burst of taps and unlocks when the call returns', async () => {
    const lock = { current: false }
    const sent: string[] = []
    let finish: () => void = () => undefined
    const first = answerOnce(
      lock,
      { status: 'open' },
      () =>
        new Promise<void>((resolve) => {
          sent.push('first')
          finish = resolve
        }),
    )
    expect(
      await answerOnce(lock, { status: 'open' }, () => {
        sent.push('second')
        return Promise.resolve()
      }),
    ).toBe(false)
    finish()
    expect(await first).toBe(true)
    // The answer then failed and the store reopened the request: answerable again.
    expect(
      await answerOnce(lock, { status: 'open' }, () => {
        sent.push('again')
        return Promise.resolve()
      }),
    ).toBe(true)
    expect(sent).toEqual(['first', 'again'])
  })

  it('sends nothing while the store says an answer is on its way', async () => {
    const lock = { current: false }
    let sent = 0
    expect(
      await answerOnce(lock, { status: 'answering' }, () => {
        sent += 1
        return Promise.resolve()
      }),
    ).toBe(false)
    expect(sent).toBe(0)
  })

  it('unlocks after a call that fails', async () => {
    const lock = { current: false }
    await expect(
      answerOnce(lock, { status: 'open' }, () => Promise.reject(new Error('lost'))),
    ).rejects.toThrow('lost')
    expect(lock.current).toBe(false)
  })
})
