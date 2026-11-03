import type { CindlEvent, LinkState } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  entry,
  hasEntry,
  initialState,
  reduce,
  selectConversationActivity,
} from '../src/index.ts'

const link: LinkState = {
  phase: 'online',
  since: '2026-01-01T00:00:00.000Z',
  connectionEpoch: 1,
}
const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']

describe('ids that are also Object.prototype names', () => {
  it.each(inherited)('%s never resolves to an inherited property', (id) => {
    const state = initialState(link)
    expect(entry(state.conversations, id)).toBeUndefined()
    expect(entry(state.messages, id)).toBeUndefined()
    expect(hasEntry(state.messages, id)).toBe(false)
    expect(selectConversationActivity(state, id).phase).toBe('unknown')
  })

  it.each(inherited)('%s works as a real conversation, message and request id', (id) => {
    const events: CindlEvent[] = [
      {
        type: 'conversation.upserted',
        conversation: {
          id,
          session: { storedId: id },
          title: id,
          kind: 'side',
          status: 'idle',
        },
      },
      { type: 'message.started', conversationId: id, messageId: id, role: 'assistant' },
      {
        type: 'message.delta',
        conversationId: id,
        messageId: id,
        kind: 'text',
        text: 'ok',
      },
      {
        type: 'message.completed',
        conversationId: id,
        messageId: id,
        status: 'complete',
      },
      {
        type: 'tool.updated',
        activity: { id, conversationId: id, name: 'x', title: 'Step', status: 'running' },
      },
      { type: 'session.status', conversationId: id, status: 'working' },
      { type: 'usage.updated', conversationId: id, usage: { inputTokens: 1 } },
    ]
    const state = events.reduce(reduce, initialState(link))
    expect(entry(state.conversations, id)?.status).toBe('working')
    expect(entry(state.messages, id)?.[0]?.parts[0]).toEqual({ type: 'text', text: 'ok' })
    expect(entry(state.tools, id)?.status).toBe('running')
    expect(entry(state.usage, id)).toEqual({ inputTokens: 1 })
    expect(Object.getPrototypeOf(state.conversations)).toBeNull()
    const removed = reduce(state, { type: 'conversation.removed', conversationId: id })
    expect(entry(removed.conversations, id)).toBeUndefined()
    expect(entry(removed.messages, id)).toBeUndefined()
  })
})
