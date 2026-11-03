import type { CindlEvent } from '@cindl/contracts'
import { HermesContract } from '@cindl/fixtures/fake-hermes'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EventNormalizer,
  handledNotifications,
  type HermesEventParams,
} from '../src/index.ts'

const contract = new HermesContract()
const NOW = '2026-06-02T08:00:00.000Z'
const SID = 'a1b2c3d4'
const CONVERSATION = '20260602_080000_abc123'

let normalizer: EventNormalizer
let seq = 0

beforeEach(() => {
  normalizer = new EventNormalizer({
    conversationFor: (sid) => (sid === SID ? CONVERSATION : undefined),
    now: () => NOW,
  })
  seq = 0
})

/** A realistic event: its payload must satisfy the vendored v0.22.5 schema. */
function event(
  type: string,
  payload: Record<string, unknown>,
  sid = SID,
): HermesEventParams {
  const check = contract.notification(type, payload)
  expect(check.errors, `${type} test payload must match the contract`).toEqual([])
  return { type, session_id: sid, payload, seq: ++seq }
}

const run = (...events: HermesEventParams[]) => {
  const out = { events: [] as CindlEvent[], effects: [] as unknown[] }
  for (const e of events) {
    const result = normalizer.normalize(e)
    out.events.push(...result.events)
    out.effects.push(...result.effects)
  }
  return out
}

describe('message streaming', () => {
  it('maps start, text and reasoning deltas, interim text and completion', () => {
    const { events } = run(
      event('message.start', {}),
      event('reasoning.delta', { text: 'Thinking' }),
      event('message.delta', { text: 'Hel' }),
      event('message.delta', { text: null }),
      event('message.interim', { text: 'lo', already_streamed: false }),
      event('message.interim', { text: 'skipped', already_streamed: true }),
      event('reasoning.available', { text: 'Thinking' }),
      event('message.complete', { text: 'Hello.', status: 'complete' }),
    )
    const messageId = `hermes:${SID}:m1`
    expect(events).toEqual([
      {
        type: 'message.started',
        conversationId: CONVERSATION,
        messageId,
        role: 'assistant',
      },
      { type: 'session.status', conversationId: CONVERSATION, status: 'working' },
      {
        type: 'message.delta',
        conversationId: CONVERSATION,
        messageId,
        kind: 'reasoning',
        text: 'Thinking',
      },
      {
        type: 'message.delta',
        conversationId: CONVERSATION,
        messageId,
        kind: 'text',
        text: 'Hel',
      },
      {
        type: 'message.delta',
        conversationId: CONVERSATION,
        messageId,
        kind: 'text',
        text: 'lo',
      },
      {
        type: 'message.completed',
        conversationId: CONVERSATION,
        messageId,
        status: 'complete',
        text: 'Hello.',
      },
      { type: 'session.status', conversationId: CONVERSATION, status: 'idle' },
    ])
  })

  it('maps thinking deltas and a reasoning block from a non-streaming provider', () => {
    const { events } = run(
      event('message.start', {}),
      event('thinking.delta', { text: 'a' }),
      event('message.complete', { text: 'b', status: 'complete' }),
      event('message.start', {}),
      event('reasoning.available', { text: 'block' }),
    )
    expect(
      events
        .filter((e) => e.type === 'message.delta')
        .map((e) => e.type === 'message.delta' && [e.kind, e.text]),
    ).toEqual([
      ['reasoning', 'a'],
      ['reasoning', 'block'],
    ])
  })

  it('reports an interrupted turn and a turn that failed with an error notice', () => {
    const { events } = run(
      event('message.start', {}),
      event('message.complete', { text: '', status: 'interrupted' }),
      event('message.start', {}),
      event('message.complete', {
        status: 'error',
        // A synthetic key, assembled so no key-shaped literal sits in the source.
        error: `provider said no; api_key=${['sk', 'synthetic', '0'.repeat(16)].join('-')}`,
      }),
    )
    const completed = events.filter((e) => e.type === 'message.completed')
    expect(completed.map((e) => e.type === 'message.completed' && e.status)).toEqual([
      'interrupted',
      'error',
    ])
    const notice = events.find((e) => e.type === 'notice')
    expect(notice).toMatchObject({ level: 'error' })
    expect(JSON.stringify(notice)).not.toContain('sk-synthetic')
  })

  it('starts a message for a delta whose start it never saw (mid-turn reconnect)', () => {
    const { events } = run(event('message.delta', { text: 'late' }))
    expect(events.map((e) => e.type)).toEqual(['message.started', 'message.delta'])
  })
})

describe('tool activity', () => {
  it('turns a generating card into the running and completed tool, with redacted previews', () => {
    const { events } = run(
      event('message.start', {}),
      event('tool.generating', { name: 'terminal' }),
      event('tool.start', {
        tool_id: 'call_1',
        name: 'terminal',
        context: 'List the fixture reports',
        args_text: 'ls /srv/hermes-fixture --token=synthetic-secret-value',
      }),
      event('tool.progress', {
        tool_id: 'call_1',
        name: 'terminal',
        progress: 1,
        total: 4,
      }),
      event('tool.output_risk', {
        tool_id: 'call_1',
        name: 'terminal',
        risk: 'medium',
        findings: ['possible credential in output'],
        redacted: true,
      }),
      event('tool.complete', {
        tool_id: 'call_1',
        name: 'terminal',
        summary: '3 files (fixture)',
      }),
    )
    const updates = events
      .filter((e) => e.type === 'tool.updated')
      .map((e) => (e.type === 'tool.updated' ? e.activity : undefined))
    expect(new Set(updates.map((a) => a?.id)).size).toBe(1)
    expect(updates.map((a) => a?.status)).toEqual([
      'generating',
      'running',
      'running',
      'running',
      'complete',
    ])
    expect(updates[1]?.title).toBe('List the fixture reports')
    expect(updates[1]?.argsPreview).not.toContain('synthetic-secret-value')
    expect(updates[2]?.progress).toBe('1 of 4')
    expect(updates[3]?.outputRisk).toEqual({
      level: 'medium',
      reason: 'possible credential in output',
    })
    expect(updates[4]).toMatchObject({ resultPreview: '3 files (fixture)', endedAt: NOW })
    expect(updates[4]).not.toHaveProperty('progress')
  })

  it('maps delegated subagents to activity', () => {
    const base = {
      goal: 'Check the fixture backups',
      task_count: 1,
      task_index: 0,
      subagent_id: 'sub-1',
    }
    const { events } = run(
      event('subagent.start', base),
      event('subagent.progress', { ...base, tool_name: 'terminal' }),
      event('subagent.complete', {
        ...base,
        status: 'failed',
        summary: 'could not reach fixture host',
      }),
    )
    const statuses = events.map(
      (e) =>
        e.type === 'tool.updated' && [
          e.activity.name,
          e.activity.status,
          e.activity.progress ?? null,
        ],
    )
    expect(statuses).toEqual([
      ['delegate', 'running', null],
      ['delegate', 'running', 'terminal'],
      ['delegate', 'error', null],
    ])
  })
})

describe('session, request and global events', () => {
  it('maps status, info, usage, titles and notices', () => {
    const { events, effects } = run(
      event('status.update', {
        kind: 'compacting',
        text: 'Compacting the context (fixture)',
      }),
      event('session.info', {
        running: true,
        title: 'Renamed (fixture)',
        stored_session_id: CONVERSATION,
      }),
      event('session.usage', { usage: { input: 10, output: 20, cost_usd: 0.01 } }),
      event('session.title', {
        session_id: CONVERSATION,
        title: 'Weekly report (fixture)',
      }),
      event('error', { message: 'model switch failed (fixture)' }),
      event('notice', { message: 'capabilities refreshed (fixture)' }),
      event('background.complete', { task_id: 'bg_abc123', text: 'done' }),
    )
    expect(events).toEqual([
      {
        type: 'session.status',
        conversationId: CONVERSATION,
        status: 'unknown',
        detail: 'Compacting the context (fixture)',
      },
      { type: 'session.status', conversationId: CONVERSATION, status: 'working' },
      {
        type: 'usage.updated',
        conversationId: CONVERSATION,
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
      },
      {
        type: 'notice',
        level: 'error',
        message: 'Hermes: model switch failed (fixture)',
      },
      {
        type: 'notice',
        level: 'info',
        message: 'Hermes: capabilities refreshed (fixture)',
      },
      { type: 'notice', level: 'info', message: 'A Hermes background task finished.' },
    ])
    expect(effects).toEqual([
      { kind: 'title', storedId: CONVERSATION, title: 'Renamed (fixture)' },
      { kind: 'title', storedId: CONVERSATION, title: 'Weekly report (fixture)' },
    ])
  })

  it('surfaces request withdrawals, change signals, display and reclaim as effects', () => {
    const lease = {
      holder: 'human',
      viewer_id: null,
      viewer_hash: 'abcdef012345',
      since: 1,
      epoch: 2,
    }
    const { effects } = run(
      event('request.cancel', {
        id: 'srq-000000000001',
        method: 'approval',
        reason: 'timeout',
      }),
      event('approval.cancelled', {
        session_id: SID,
        stored_session_id: CONVERSATION,
        reason: 'interrupted',
        cancelled_count: 1,
        request_ids: ['f'.repeat(32)],
      }),
      event('sessions.changed', {}, ''),
      event('cron.changed', {}, ''),
      event('skills.changed', {}, ''),
      event('display.lease', { profile_key: 'fixture-profile', lease }, ''),
      event(
        'display.status',
        {
          profile: 'default',
          supported: true,
          installed: true,
          missing: [],
          running: false,
          geometry: '1280x800',
          lease,
          profile_key: 'fixture-profile',
        },
        '',
      ),
      event('session.reclaimed', {
        session_id: SID,
        stored_session_id: CONVERSATION,
        reason: 'reaped',
      }),
    )
    expect(effects.map((e) => (e as { kind: string }).kind)).toEqual([
      'request-cancelled',
      'approvals-cancelled',
      'sessions-changed',
      'cron-changed',
      'skills-changed',
      'display-lease',
      'display-status',
      'session-reclaimed',
    ])
    expect(effects[0]).toEqual({
      kind: 'request-cancelled',
      requestId: 'srq-000000000001',
      reason: 'timeout',
    })
  })

  it('ignores unknown event types and events for sessions it does not know', () => {
    expect(
      normalizer.normalize({
        type: 'pet.mood',
        session_id: SID,
        payload: { mood: 'happy' },
      }),
    ).toEqual({ events: [], effects: [] })
    expect(run(event('message.start', {}, 'ffffffff')).events).toEqual([])
  })

  it('drops a payload that does not match instead of guessing', () => {
    expect(
      normalizer.normalize({
        type: 'tool.start',
        session_id: SID,
        payload: { name: 42 },
      }),
    ).toEqual({ events: [], effects: [] })
  })

  it('covers every notification on the allowlist', () => {
    const covered = new Set([
      'gateway.ready',
      'message.start',
      'message.delta',
      'message.interim',
      'message.complete',
      'reasoning.delta',
      'reasoning.available',
      'thinking.delta',
      'tool.generating',
      'tool.start',
      'tool.progress',
      'tool.complete',
      'tool.output_risk',
      'status.update',
      'session.info',
      'session.usage',
      'session.title',
      'sessions.changed',
      'error',
      'notice',
      'request.cancel',
      'approval.cancelled',
      'background.complete',
      'cron.changed',
      'display.status',
      'display.lease',
      'subagent.start',
      'subagent.progress',
      'subagent.complete',
      'skills.changed',
      'session.reclaimed',
    ])
    expect([...handledNotifications].filter((type) => !covered.has(type))).toEqual([])
  })
})
