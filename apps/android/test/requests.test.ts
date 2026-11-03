import { clientOps, type ClarifyQuestion, type ServerRequest } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  answerArgs,
  buildClarifyAnswer,
  chooseOther,
  clarifyDraftStore,
  describeResponse,
  draftFor,
  emptyDraft,
  isQuickQuestion,
  pickChoice,
  requestKeyOf,
  responseFor,
  setSkipped,
  splitQuestions,
  typeAnswer,
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

describe('one reply for the whole clarify set (contract v3)', () => {
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
    expect(() =>
      clientOps['request.answer'].args.parse(
        answerArgs(request, answer ?? { kind: 'clarify-cancel' }),
      ),
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
