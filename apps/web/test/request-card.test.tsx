import { CindlProvider } from '@cindl/client-react'
import {
  CindlError,
  type CindlClientApi,
  type CindlEvent,
  type ServerRequest,
} from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneRequestDrafts, RequestCard } from '../src/talk/RequestCard.tsx'

afterEach(cleanup)

const question = (overrides: Partial<ServerRequest> = {}): ServerRequest => ({
  requestId: 'srq-0000000000a1',
  lastSeenEpoch: 1,
  kind: 'clarify',
  conversationId: 'c1',
  title: 'Venue and prep',
  questions: [
    {
      qid: 'venue',
      question: 'Which venue?',
      choices: ['North hall', 'South hall'],
      multiSelect: false,
    },
    {
      qid: 'prep',
      question: 'What should I prepare?',
      choices: ['Floor plan', 'Quotes'],
      multiSelect: true,
    },
  ],
  choices: [],
  receivedAt: '2026-01-01T00:00:00.000Z',
  status: 'open',
  ...overrides,
})

/** In-test client recording request.answer calls; optionally failing them. */
function harness(request: ServerRequest, fail?: Error) {
  const answers: unknown[] = []
  const api: CindlClientApi = {
    call: (name, args) => {
      if (name !== 'request.answer')
        return Promise.reject(new Error(`unexpected ${name}`))
      answers.push((args as { answer: unknown }).answer)
      return fail
        ? Promise.reject(fail)
        : Promise.resolve({ ...request, status: 'answering' } as never)
    },
    subscribe(listener: (event: CindlEvent) => void) {
      queueMicrotask(() => listener({ type: 'request.opened', request }))
      return () => undefined
    },
  }
  render(
    <CindlProvider api={api}>
      <RequestCard request={request} />
    </CindlProvider>,
  )
  return answers
}

const settle = () =>
  act(async () => {
    await Promise.resolve()
  })

describe('question card', () => {
  it('sends ticked options and typed text together for a multi-select question', async () => {
    const answers = harness(question())
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: 'North hall' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Floor plan' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: /Your own answer to: What should I prepare/ }),
      {
        target: { value: 'Parking map' },
      },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    await settle()
    expect(answers).toEqual([
      {
        kind: 'clarify',
        answers: {
          venue: { choices: ['North hall'] },
          prep: { choices: ['Floor plan', 'Parking map'] },
        },
      },
    ])
  })

  it('treats question ids named like Object.prototype members as ordinary ids', async () => {
    const answers = harness(
      question({
        requestId: 'srq-0000000000a3',
        questions: [
          {
            qid: 'constructor',
            question: 'Which venue?',
            choices: ['North hall', 'South hall'],
            multiSelect: false,
          },
          {
            qid: 'toString',
            question: 'What should I prepare?',
            choices: ['Floor plan', 'Quotes'],
            multiSelect: true,
          },
        ],
      }),
    )
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: 'South hall' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Quotes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    await settle()
    expect(answers).toEqual([
      {
        kind: 'clarify',
        answers: {
          constructor: { choices: ['South hall'] },
          toString: { choices: ['Quotes'] },
        },
      },
    ])
  })

  it('skips every open question with "Skip all" (there is no decline)', async () => {
    const answers = harness(
      question({
        requestId: 'srq-0000000000a5',
        lockedAnswers: { venue: { choices: ['North hall'] } },
      }),
    )
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    await settle()
    // The question another device locked is left out; the open one is skipped.
    expect(answers).toEqual([{ kind: 'clarify', answers: { prep: { skipped: true } } }])
    expect(screen.queryByRole('button', { name: /Decline/ })).toBeNull()
  })

  it('forgets drafts once their request is no longer open', async () => {
    const request = question({ requestId: 'srq-0000000000a4' })
    harness(request)
    await settle()
    const other = () =>
      screen.getByRole('textbox', { name: /Your own answer to: What should I prepare/ })
    fireEvent.change(other(), { target: { value: 'Parking map' } })
    cleanup()
    harness(request)
    await settle()
    expect((other() as HTMLInputElement).value).toBe('Parking map')
    cleanup()
    pruneRequestDrafts(new Set(['srq-0000000000ff']))
    harness(request)
    await settle()
    expect((other() as HTMLInputElement).value).toBe('')
  })

  it('shows answers locked on another device and leaves them out of the reply', async () => {
    const answers = harness(
      question({ lockedAnswers: { venue: { choices: ['South hall'] } } }),
    )
    await settle()
    expect(screen.getByText('Answered on another device: South hall')).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'North hall' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skip this question' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    await settle()
    expect(answers).toEqual([{ kind: 'clarify', answers: { prep: { skipped: true } } }])
  })

  it('offers nothing to send when every question is locked', async () => {
    harness(
      question({ lockedAnswers: { venue: { text: 'x' }, prep: { skipped: true } } }),
    )
    await settle()
    expect(screen.getByText(/Every question was answered on another device/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull()
  })

  it('stays answerable after a send whose outcome is unknown, and says so', async () => {
    const answers = harness(
      question({
        kind: 'approval',
        title: 'Run a command',
        command: 'echo synthetic',
        choices: ['once', 'deny'],
        questions: undefined,
      }),
      new Error('socket closed'),
    )
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/could not confirm/i)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled,
    ).toBe(false)
    expect(answers).toHaveLength(1)
  })

  it('shows Hermes-reported problems as they are', async () => {
    harness(
      question({
        kind: 'approval',
        title: 'Run',
        choices: ['once', 'deny'],
        questions: undefined,
      }),
      new CindlError('conflict', 'This request was already answered or closed.'),
    )
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(
      'This request was already answered or closed.',
    )
  })
})
