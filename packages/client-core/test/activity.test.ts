import type {
  CindlEvent,
  Conversation,
  LinkState,
  ServerRequest,
  ToolActivity,
} from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { initialState, reduce, selectConversationActivity } from '../src/index.ts'

const link: LinkState = {
  phase: 'online',
  since: '2026-01-01T00:00:00.000Z',
  connectionEpoch: 1,
}
const run = (events: CindlEvent[]) => events.reduce(reduce, initialState(link))
const conversation = (id: string, status: Conversation['status']): CindlEvent => ({
  type: 'conversation.upserted',
  conversation: { id, session: { storedId: id }, title: id, kind: 'side', status },
})
const tool = (
  status: ToolActivity['status'],
  id = 't1',
  conversationId = 'c1',
): CindlEvent => ({
  type: 'tool.updated',
  activity: { id, conversationId, name: 'terminal', title: 'Run export', status },
})
const request: ServerRequest = {
  rpcId: 'r1',
  connectionEpoch: 1,
  kind: 'approval',
  conversationId: 'c1',
  title: 'Run export',
  choices: ['once', 'deny'],
  receivedAt: '2026-01-01T00:00:01.000Z',
  status: 'open',
}
const streaming: CindlEvent = {
  type: 'message.started',
  conversationId: 'c1',
  messageId: 'm1',
  role: 'assistant',
}

describe('conversation activity', () => {
  it('is waiting on you, not executing, while a request is open', () => {
    const activity = selectConversationActivity(
      run([
        conversation('c1', 'working'),
        streaming,
        tool('running'),
        { type: 'request.opened', request },
      ]),
      'c1',
    )
    expect(activity.phase).toBe('waiting-on-you')
    expect(activity.executingTools).toEqual([])
    expect([...activity.blockedToolIds]).toEqual(['t1'])
    expect(activity.turnOpen).toBe(true)
  })

  it('is executing only when a step is actually running', () => {
    expect(
      selectConversationActivity(run([conversation('c1', 'idle'), tool('running')]), 'c1')
        .phase,
    ).toBe('executing')
    expect(
      selectConversationActivity(
        run([conversation('c1', 'idle'), tool('complete')]),
        'c1',
      ).phase,
    ).toBe('idle')
  })

  it('returns to executing once the request is answered', () => {
    const state = run([
      conversation('c1', 'working'),
      tool('running'),
      { type: 'request.opened', request },
      { type: 'request.closed', rpcId: 'r1', status: 'answered' },
    ])
    expect(selectConversationActivity(state, 'c1').phase).toBe('executing')
  })

  it('reports queued prompts separately from execution', () => {
    const state = run([
      conversation('c1', 'idle'),
      {
        type: 'prompt.updated',
        prompt: {
          clientId: 'p1',
          conversationId: 'c1',
          text: 'next',
          createdAt: '2026-01-01T00:00:02.000Z',
          state: 'accepted',
          disposition: 'queued',
        },
      },
    ])
    expect(selectConversationActivity(state, 'c1')).toMatchObject({
      phase: 'queued',
      queuedPrompts: 1,
    })
  })

  it('counts other conversations that are executing', () => {
    const state = run([
      conversation('c1', 'idle'),
      conversation('c2', 'working'),
      conversation('c3', 'working'),
    ])
    expect(selectConversationActivity(state, 'c1')).toMatchObject({
      phase: 'idle',
      otherExecuting: 2,
    })
  })

  it('is unknown for a conversation Cindl has not seen', () => {
    expect(selectConversationActivity(run([]), 'missing').phase).toBe('unknown')
  })
})
