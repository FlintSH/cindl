import { sha256Hex } from '@cindl/client-core'
import type { CindlEvent } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { createScenarioClient } from '../src/index.ts'

function harness() {
  let now = Date.parse('2026-06-02T08:00:00.000Z')
  const queue: Array<{ at: number; run: () => void; id: number }> = []
  let ids = 0
  const timers = {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const id = ++ids
      queue.push({ at: now + ms, run, id })
      return id
    },
    clearTimeout: (id: unknown) => {
      const index = queue.findIndex((t) => t.id === id)
      if (index >= 0) queue.splice(index, 1)
    },
  }
  const flush = () => {
    while (queue.length) {
      queue.sort((a, b) => a.at - b.at)
      const next = queue.shift()
      if (!next) break
      now = next.at
      next.run()
    }
  }
  const client = createScenarioClient({ timers })
  const events: CindlEvent[] = []
  client.subscribe((event) => events.push(event))
  client.start()
  return { client, events, flush }
}

describe('synthetic scenario client', () => {
  it('always identifies itself as a demo with no Hermes connection', async () => {
    const { client, events } = harness()
    const link = await client.call('link.get', {})
    expect(link).toMatchObject({ demo: true, auth: 'demo-fixture' })
    expect(events[0]).toMatchObject({ type: 'link.changed', link: { demo: true } })
  })

  it('reports unsupported Hermes v0.22.5 capabilities honestly', async () => {
    const { client } = harness()
    const capabilities = await client.call('capabilities.get', {})
    expect(capabilities['connections.accounts']?.state).toBe('unsupported')
    expect(capabilities['presence.unified']?.state).toBe('unavailable')
    expect(capabilities['sessions.replay']?.state).toBe('limited')
    await expect(client.call('connections.accounts', {})).rejects.toMatchObject({
      code: 'unsupported',
    })
  })

  it('edits memory entries like Hermes: the id is the version, deletes are final', async () => {
    const { client } = harness()
    const entries = await client.call('memory.entries', {})
    expect(entries.map((e) => e.store)).toEqual([
      'memory',
      'memory',
      'memory',
      'profile',
      'profile',
    ])
    const first = entries[0]!
    expect(first.id).toMatch(/^memory:memory:0:[a-f0-9]{12}$/)
    // Hermes numbers entries across both stores, agent notes first (review
    // 91f30e07 N2): the first note about the owner is entry 3, not 0.
    expect(entries[3]!.id).toMatch(/^memory:profile:3:[a-f0-9]{12}$/)
    const read = await client.call('memory.read', { id: first.id })
    expect(read.content).toContain('Thursdays')

    const saved = await client.call('memory.write', {
      id: first.id,
      content: 'Glaze supplier calls moved to Wednesdays at 10:00 (fictional supplier).',
      confirm: true,
    })
    expect(saved.id).not.toBe(first.id)
    // The old id names content that no longer exists: Hermes refuses it.
    await expect(
      client.call('memory.write', { id: first.id, content: 'x', confirm: true }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      client.call('memory.write', {
        id: saved.id,
        content: 'y'.repeat(2_201),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid' })

    await client.call('memory.delete', { id: saved.id, confirm: true })
    const after = await client.call('memory.entries', {})
    expect(after).toHaveLength(4)
    expect(after.some((e) => e.preview.includes('Wednesdays'))).toBe(false)
    await expect(client.call('memory.read', { id: saved.id })).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('refuses to answer a prompt Cindl does not answer, and sends nothing', async () => {
    const { client } = harness()
    await expect(
      client.call('request.answer', {
        requestId: 'srq-00000000dea3',
        answer: { kind: 'approval', choice: 'deny' },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('answers a request once, with an offered choice only', async () => {
    const { client, flush } = harness()
    const requestId = 'srq-00000000dea1'
    await expect(
      client.call('request.answer', {
        requestId: 'srq-0000000000ff',
        answer: { kind: 'approval', choice: 'once' },
      }),
    ).rejects.toMatchObject({ code: 'not-found' })
    const answered = await client.call('request.answer', {
      requestId,
      answer: { kind: 'approval', choice: 'deny' },
    })
    expect(answered.status).toBe('answering')
    await expect(
      client.call('request.answer', {
        requestId,
        answer: { kind: 'approval', choice: 'once' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    flush()
  })

  it('requires one submission covering every clarify question', async () => {
    const { client, flush } = harness()
    const requestId = 'srq-00000000dea2'
    await expect(
      client.call('request.answer', {
        requestId,
        answer: {
          kind: 'clarify',
          answers: { venue: { choices: ['Harbor Loft (fictional)'] } },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
    const answered = await client.call('request.answer', {
      requestId,
      answer: {
        kind: 'clarify',
        answers: {
          venue: { choices: ['Harbor Loft (fictional)'] },
          prep: { skipped: true },
        },
      },
    })
    expect(answered.status).toBe('answering')
    flush()
  })

  it('rejects SOUL edits made against a stale version', async () => {
    const { client } = harness()
    const soul = await client.call('soul.read', {})
    expect(soul.version).toBe(sha256Hex(soul.content))
    const saved = await client.call('soul.write', {
      content: soul.content + '\n- Synthetic edit.\n',
      expectedVersion: soul.version,
      confirm: true,
    })
    expect(saved.version).not.toBe(soul.version)
    await expect(
      client.call('soul.write', {
        content: 'stale',
        expectedVersion: soul.version,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('streams a labelled synthetic reply to a prompt', async () => {
    const { client, events, flush } = harness()
    const prompt = await client.call('prompt.submit', {
      conversationId: 'demo-inventory',
      clientId: 'p-1',
      text: 'Status?',
    })
    expect(prompt).toMatchObject({ state: 'accepted', disposition: 'streaming' })
    flush()
    const text = events
      .filter(
        (e): e is Extract<CindlEvent, { type: 'message.delta' }> =>
          e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('')
    expect(text).toContain('synthetic demo')
    expect(events.at(-1)).toMatchObject({ type: 'conversation.upserted' })
  })
})
