import { createStore, type ClientState } from '@cindl/client-core'
import type { CindlClientApi, CindlEvent } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { describe, expect, it, vi } from 'vitest'
import { createClientHost, type EventSink } from '../src/main/host.ts'
import { snapshotEvents } from '../src/main/snapshot.ts'

/** Manually driven timers so the synthetic scenario can be paused mid-stream. */
function manualTimers() {
  let now = Date.parse('2026-06-02T08:00:00.000Z')
  const queue: Array<{ at: number; run: () => void; id: number }> = []
  let id = 0
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      queue.push({ at: now + ms, run, id: ++id })
      return id
    },
    clearTimeout: (handle: unknown) => {
      const index = queue.findIndex((entry) => entry.id === handle)
      if (index >= 0) queue.splice(index, 1)
    },
    advance(ms: number) {
      now += ms
      queue.sort((a, b) => a.at - b.at)
      while (queue[0] && queue[0].at <= now) (queue.shift() as { run: () => void }).run()
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const withoutNotices = (state: ClientState) => ({ ...state, notices: [] })

function rebuild(events: CindlEvent[], from: ClientState) {
  const store = createStore({ ...from.link, phase: 'connecting' })
  for (const event of events) store.dispatch(event)
  return store.getState()
}

function sink(): EventSink & { events: CindlEvent[]; open: boolean } {
  const target = {
    events: [] as CindlEvent[],
    open: true,
    alive: () => target.open,
    send: (event: CindlEvent) => target.events.push(event),
  }
  return target
}

describe('snapshot replay', () => {
  it('rebuilds the mirror state exactly, including a reply streaming with a tool', async () => {
    const timers = manualTimers()
    const client = createScenarioClient({ timers })
    const host = createClientHost({ client, now: timers.now })
    await flush()
    // Start a reply and stop after the tool started and some text arrived.
    await host.call('prompt.submit', {
      conversationId: 'demo-inventory',
      clientId: 'snapshot-test',
      text: 'Check the kiln sheet',
    })
    timers.advance(1000)
    const mirror = host.getState()
    const streaming = Object.values(mirror.messages)
      .flat()
      .filter((m) => m.status === 'streaming')
    expect(streaming.length).toBeGreaterThan(0)
    const rebuilt = rebuild(snapshotEvents(mirror), mirror)
    expect(withoutNotices(rebuilt)).toEqual(withoutNotices(mirror))
    host.dispose()
  })

  it('reproduces answered requests without reopening them', async () => {
    const timers = manualTimers()
    const client = createScenarioClient({ timers })
    const host = createClientHost({ client, now: timers.now })
    await flush()
    const open = Object.values(host.getState().requests).find(
      (r) => r.status === 'open' && r.kind === 'approval',
    )
    expect(open).toBeDefined()
    if (!open) return
    await host.call('request.answer', {
      requestId: open.requestId,
      answer: { kind: 'approval', choice: 'deny' },
    })
    timers.advance(5000)
    expect(host.getState().requests[open.requestId]?.status).toBe('answered')
    const mirror = host.getState()
    expect(withoutNotices(rebuild(snapshotEvents(mirror), mirror))).toEqual(
      withoutNotices(mirror),
    )
    host.dispose()
  })
})

describe('snapshot replay of resolved requests', () => {
  it('keeps requests that were resolved elsewhere closed in the rebuilt state', () => {
    const listeners = new Set<(event: CindlEvent) => void>()
    const client: CindlClientApi = {
      call: vi.fn(),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const host = createClientHost({ client })
    const request = {
      requestId: 'srq-0123456789ab',
      lastSeenEpoch: 1,
      kind: 'approval' as const,
      conversationId: 'conversation-synthetic',
      title: 'Approve (synthetic)',
      choices: ['once' as const, 'deny' as const],
      receivedAt: '2026-06-02T08:00:00.000Z',
      status: 'open' as const,
    }
    for (const listener of listeners) {
      listener({ type: 'request.opened', request })
      listener({
        type: 'requests.synced',
        conversationId: 'conversation-synthetic',
        openRequestIds: [],
      })
    }
    const mirror = host.getState()
    expect(mirror.requests['srq-0123456789ab']?.status).toBe('resolved-elsewhere')
    expect(withoutNotices(rebuild(snapshotEvents(mirror), mirror))).toEqual(
      withoutNotices(mirror),
    )
    host.dispose()
  })
})

describe('client host', () => {
  it('sends a snapshot on attach, then live events, and stops on detach', async () => {
    const timers = manualTimers()
    const host = createClientHost({
      client: createScenarioClient({ timers }),
      now: timers.now,
    })
    await flush()
    const window = sink()
    host.attach(1, window)
    expect(window.events[0]).toMatchObject({ type: 'link.changed' })
    expect(window.events[1]).toMatchObject({ type: 'capabilities.changed' })
    const snapshotSize = window.events.length
    await host.call('conversations.create', { title: 'Side' })
    expect(window.events.length).toBeGreaterThan(snapshotSize)
    host.detach(1)
    const before = window.events.length
    await host.call('conversations.create', { title: 'Another' })
    expect(window.events.length).toBe(before)
    host.dispose()
  })

  it('replays a full snapshot on every re-subscribe (renderer reload)', async () => {
    const timers = manualTimers()
    const host = createClientHost({
      client: createScenarioClient({ timers }),
      now: timers.now,
    })
    await flush()
    const first = sink()
    host.attach(1, first)
    const reloaded = sink()
    host.attach(1, reloaded)
    expect(reloaded.events.length).toBe(first.events.length)
    host.dispose()
  })

  it('drops windows that are gone and appends platform notices', () => {
    const listeners = new Set<(event: CindlEvent) => void>()
    const client: CindlClientApi = {
      call: vi.fn(),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const notice: CindlEvent = {
      type: 'notice',
      level: 'warning',
      message: 'memory only',
    }
    const host = createClientHost({ client, notices: () => [notice] })
    const window = sink()
    host.attach(3, window)
    expect(window.events.at(-1)).toEqual(notice)
    window.open = false
    const count = window.events.length
    for (const listener of listeners)
      listener({ type: 'notice', level: 'info', message: 'live' })
    expect(window.events.length).toBe(count)
    host.dispose()
    expect(listeners.size).toBe(0)
  })
})
