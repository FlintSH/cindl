import { CindlError, parseOpArgs } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  ANSWER_REFUSED,
  ANSWER_UNCERTAIN,
  describeFailure,
  NOT_APPLIED,
  SEND_UNCERTAIN,
} from '../src/talk/failures.ts'

describe('failure copy never overstates certainty', () => {
  it.each([
    'invalid',
    'offline',
    'unsupported',
    'unavailable',
    'unauthenticated',
  ] as const)('a send rejected with %s certainly did not reach Hermes', (code) => {
    expect(
      describeFailure(new CindlError(code, 'Rejected.'), SEND_UNCERTAIN, NOT_APPLIED),
    ).toEqual({
      certain: true,
      message: 'Rejected.',
    })
  })

  it.each([
    'timeout',
    'uncertain',
    'protocol',
    'internal',
    'conflict',
    'forbidden',
  ] as const)('a send failing with %s may have reached Hermes', (code) => {
    expect(
      describeFailure(new CindlError(code, 'Lost.'), SEND_UNCERTAIN, NOT_APPLIED),
    ).toEqual({
      certain: false,
      message: SEND_UNCERTAIN,
    })
  })

  it('treats unknown errors as uncertain and says the message may have been sent', () => {
    const copy = describeFailure(new TypeError('Network request failed'), SEND_UNCERTAIN)
    expect(copy.certain).toBe(false)
    expect(copy.message).toMatch(/could not confirm whether this message was sent/)
  })

  it('reports refused answers plainly and everything else as unconfirmed', () => {
    expect(
      describeFailure(
        new CindlError('conflict', 'Already answered.'),
        ANSWER_UNCERTAIN,
        ANSWER_REFUSED,
      ),
    ).toEqual({ certain: true, message: 'Already answered.' })
    expect(
      describeFailure(
        new CindlError('timeout', 'Timed out.'),
        ANSWER_UNCERTAIN,
        ANSWER_REFUSED,
      ).message,
    ).toBe(ANSWER_UNCERTAIN)
  })

  // Contract v4: validation says "Not sent: …" and Cindl shows it as it is.
  it('shows "Not sent" validation messages as they are, for messages and answers', () => {
    const rejection = (name: 'prompt.submit' | 'request.answer', args: unknown) => {
      try {
        parseOpArgs(name, args)
      } catch (error) {
        return error
      }
      throw new Error('expected a validation failure')
    }
    const longMessage = rejection('prompt.submit', {
      conversationId: 'demo-main',
      clientId: 'client-1',
      text: 'x'.repeat(100_001),
    })
    expect(describeFailure(longMessage, SEND_UNCERTAIN, NOT_APPLIED)).toEqual({
      certain: true,
      message: 'Not sent: the text is longer than 100,000 characters.',
    })
    const longAnswer = rejection('request.answer', {
      requestId: 'srq-00000000dea2',
      answer: { kind: 'clarify', answers: { q0: { text: 'x'.repeat(20_001) } } },
    })
    expect(describeFailure(longAnswer, ANSWER_UNCERTAIN, ANSWER_REFUSED)).toEqual({
      certain: true,
      message: 'Not sent: the text is longer than 20,000 characters.',
    })
  })

  it('says plainly that Cindl does not answer a prompt it never answers', () => {
    const refusal = new CindlError(
      'unsupported',
      'Cindl does not answer this kind of prompt. Answer it in another Hermes surface.',
    )
    expect(describeFailure(refusal, ANSWER_UNCERTAIN, ANSWER_REFUSED)).toEqual({
      certain: true,
      message: refusal.message,
    })
  })
})
