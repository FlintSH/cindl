import {
  DisplayState,
  McpServerStatus,
  Message,
  Routine,
  ToolActivity,
} from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  displayState,
  isoFromSeconds,
  isoFromString,
  mcpFromStatus,
  memoryOverviewFrom,
  routineFromJob,
  transcriptToHistory,
} from '../src/index.ts'

describe('mappers', () => {
  it('normalizes Hermes timestamps to UTC ISO strings and drops undatable values', () => {
    expect(isoFromSeconds(1_780_000_000)).toBe('2026-05-28T20:26:40.000Z')
    expect(isoFromSeconds(0)).toBeUndefined()
    expect(isoFromString('2026-06-03T08:00:00+02:00')).toBe('2026-06-03T06:00:00.000Z')
    expect(isoFromString('not a date')).toBeUndefined()
  })

  it('maps a transcript with tool rows anchored in the assistant message', () => {
    const { messages, tools } = transcriptToHistory('c1', [
      {
        role: 'user',
        text: 'List the reports (fixture)',
        row_id: 1,
        timestamp: 1_780_000_000,
      },
      { role: 'assistant', text: 'Checking.', reasoning: 'Need the list.', row_id: 2 },
      {
        role: 'tool',
        name: 'terminal',
        context: 'ls reports',
        content: 'a.md\nb.md',
        row_id: 3,
      },
      { role: 'session_meta', text: 'ignored', row_id: 4 },
    ])
    for (const message of messages) Message.parse(message)
    for (const tool of tools) ToolActivity.parse(tool)
    expect(messages.map((m) => [m.role, m.parts.map((p) => p.type)])).toEqual([
      ['user', ['text']],
      ['assistant', ['reasoning', 'text', 'tool']],
    ])
    expect(tools).toEqual([
      expect.objectContaining({
        id: 'hermes:c1:3',
        name: 'terminal',
        title: 'ls reports',
        status: 'complete',
        resultPreview: 'a.md\nb.md',
      }),
    ])
  })

  it('maps cron jobs, including paused ones and offset timestamps', () => {
    const routine = routineFromJob({
      job_id: 'job-1',
      name: 'Backup check (fixture)',
      schedule: 'every 6h',
      enabled: false,
      state: 'paused',
      next_run_at: null,
      last_run_at: '2026-06-01T12:00:00+00:00',
      last_status: 'delivery_failed',
    })
    expect(Routine.parse(routine)).toEqual({
      id: 'job-1',
      name: 'Backup check (fixture)',
      schedule: 'every 6h',
      enabled: false,
      lastRun: { at: '2026-06-01T12:00:00.000Z', status: 'error' },
    })
  })

  it('maps MCP health without transport details', () => {
    const servers = mcpFromStatus({
      servers: [
        {
          name: 'fixture-notes',
          tools: 3,
          connected: true,
          disabled: false,
          status: 'connected',
        },
        {
          name: 'fixture-lazy',
          tools: 0,
          connected: false,
          disabled: false,
          status: 'lazy',
        },
        {
          name: 'fixture-broken',
          tools: 0,
          connected: false,
          disabled: false,
          status: 'failed',
        },
      ],
      checked_at: 1_780_000_000,
    })
    for (const server of servers) McpServerStatus.parse(server)
    expect(servers.map((s) => [s.name, s.state])).toEqual([
      ['fixture-notes', 'connected'],
      ['fixture-lazy', 'unknown'],
      ['fixture-broken', 'error'],
    ])
    expect(Object.keys(servers[0] ?? {}).sort()).toEqual([
      'checkedAt',
      'name',
      'state',
      'toolCount',
    ])
  })

  it('recognises this device as the lease holder only through its viewer hash', () => {
    const status = { supported: true, installed: true, running: true }
    const lease = {
      holder: 'human' as const,
      viewer_hash: 'aaaaaaaaaaaa',
      since: 1,
      epoch: 1,
    }
    const at = '2026-06-02T08:00:00.000Z'
    const mine = displayState(
      status,
      lease,
      { current: 'aaaaaaaaaaaa', previous: new Set() },
      at,
    )
    expect(DisplayState.parse(mine)).toMatchObject({
      controller: 'you',
      leaseHeldByThisDevice: true,
    })
    expect(
      displayState(status, lease, { current: 'bbbbbbbbbbbb', previous: new Set() }, at),
    ).toMatchObject({
      controller: 'another-viewer',
      leaseHeldByThisDevice: false,
    })
    expect(
      displayState(status, lease, { previous: new Set(['aaaaaaaaaaaa']) }, at),
    ).toMatchObject({
      controller: 'you',
      leaseHeldByThisDevice: false,
    })
    expect(displayState(undefined, undefined, { previous: new Set() }, at)).toMatchObject(
      { status: 'unknown', controller: 'unknown' },
    )
  })

  it('describes memory metadata without memory text', () => {
    const overview = memoryOverviewFrom(
      {
        active: '',
        providers: [{ name: 'fixture-provider', available: false }],
        builtin_files: { memory: 120, user: 0 },
      },
      '2026-06-02T08:00:00.000Z',
    )
    expect(overview.items).toEqual([
      { key: 'builtin:memory', label: 'Agent notes (MEMORY.md)', detail: '120 bytes' },
      { key: 'builtin:user', label: 'User profile (USER.md)', detail: 'empty' },
      {
        key: 'provider:fixture-provider',
        label: 'Memory provider: fixture-provider',
        detail: 'unavailable',
      },
    ])
  })
})
