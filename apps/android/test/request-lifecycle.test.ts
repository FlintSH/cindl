import { createStore, entry, selectOpenRequests } from '@cindl/client-core'
import type { LinkState, ServerRequest } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { describe, expect, it } from 'vitest'
import { sendAnswer } from '../src/talk/requests.ts'

// Request statuses come from the shared reducer, fed by a client that behaves like the
// real ones (the synthetic scenario): `answering` while the answer is on its way, and
// `answered` only once Hermes acknowledged it.
const online: LinkState = {
  phase: 'online',
  since: '2026-06-02T08:00:00.000Z',
  connectionEpoch: 1,
}

async function started() {
  const store = createStore(online)
  const client = createScenarioClient({ speed: 0 })
  const calls: string[] = []
  const api = {
    call: ((name, args) => {
      calls.push(name)
      return client.call(name, args)
    }) as typeof client.call,
  }
  client.subscribe((event) => store.dispatch(event))
  client.start()
  await Promise.resolve()
  const status = (id: string) => entry(store.getState().requests, id)?.status
  const open = () => selectOpenRequests(store.getState())
  const find = (kind: ServerRequest['kind']) => {
    const request = open().find((r) => r.kind === kind)
    if (!request) throw new Error(`no open ${kind} request in the scenario`)
    return request
  }
  return { api, calls, status, open, find }
}

const acknowledged = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('request statuses from the shared reducer', () => {
  it('shows an answer as on its way until Hermes acknowledges it', async () => {
    const { api, status, open, find } = await started()
    const approval = find('approval')
    const sent = sendAnswer(api, approval, { kind: 'approval', choice: 'deny' })
    expect(status(approval.requestId)).toBe('answering')
    expect(open().map((r) => r.requestId)).toContain(approval.requestId)
    await sent
    await acknowledged()
    expect(status(approval.requestId)).toBe('answered')
    expect(open().map((r) => r.requestId)).not.toContain(approval.requestId)
  })

  it('keeps a prompt Cindl does not answer open and sends nothing for it', async () => {
    const { api, calls, status, find } = await started()
    const sudo = find('unsupported')
    expect(sudo.unsupportedKind).toBe('sudo')
    await expect(
      sendAnswer(api, sudo, { kind: 'approval', choice: 'deny' }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    await acknowledged()
    expect(calls).toEqual([])
    expect(status(sudo.requestId)).toBe('open')
  })

  it('shows "Not sent" validation messages as they are, with nothing sent', async () => {
    const { api, status, find } = await started()
    const question = find('clarify')
    await expect(
      sendAnswer(api, question, {
        kind: 'clarify',
        answers: { [question.questions?.[0]?.qid ?? 'q0']: { text: 'x'.repeat(20_001) } },
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'Not sent: the text is longer than 20,000 characters.',
    })
    expect(status(question.requestId)).toBe('open')
  })
})
