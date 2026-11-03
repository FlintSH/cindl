import { createHash } from 'node:crypto'
import { CindlError } from '@cindl/contracts'
import { memoryFingerprint as fixtureFingerprint } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { MemoryEntries, parseMemoryEntryId, RestClient } from '../src/index.ts'
import { bearerRest, fakeHermes, timers } from './harness.ts'

const sha256Hex = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex')
const NOW = '2026-06-02T08:00:00.000Z'

async function setup() {
  const fake = await fakeHermes()
  const rest = bearerRest(fake, fake.signIn())
  const memory = new MemoryEntries({ rest, sha256Hex, now: () => NOW })
  const writes = () =>
    fake.calls.filter(
      (c) =>
        c.name === 'PUT /api/learning/node' || c.name === 'DELETE /api/learning/node',
    )
  return { fake, memory, writes }
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof CindlError ? error.code : 'not-a-cindl-error'),
  )

describe('memory entries (backing the memory.* operations)', () => {
  it('lists entries with fingerprinted ids and reads one by its id', async () => {
    const { memory } = await setup()
    const entries = await memory.list()
    expect(entries.map((e) => [e.store, e.id.split(':').length])).toEqual([
      ['memory', 4],
      ['memory', 4],
      ['profile', 4],
    ])
    const first = entries[0]
    if (!first) throw new Error('no entries')
    // The fingerprint lives in the id: memory:<store>:<index>:<fingerprint>.
    expect(first.id.split(':')[3]).toBe(fixtureFingerprint(first.preview))
    const doc = await memory.read(first.id)
    expect(doc).toEqual({
      id: first.id,
      store: 'memory',
      content: first.preview,
      readAt: NOW,
      source: 'GET /api/learning/node',
    })
  })

  it('numbers entries across both stores, agent notes first, like Hermes', async () => {
    // memory_node_id(card, i) over _memory_cards(): MEMORY.md cards, then USER.md
    // (agent/learning_graph.py:155-185, 238-245). A per-store count would name a
    // profile entry memory:profile:0 instead.
    const { fake, memory } = await setup()
    const entries = await memory.list()
    expect(entries.map((e) => e.id.split(':').slice(1, 3).join(':'))).toEqual([
      'memory:0',
      'memory:1',
      'profile:2',
    ])
    const profileEntry = entries[2]
    if (!profileEntry) throw new Error('no profile entry')
    await expect(memory.read(profileEntry.id)).resolves.toMatchObject({
      store: 'profile',
      content: fake.store.profile('default').memory.profile[0],
    })
  })

  it('writes with the exact id that was read and returns the new id', async () => {
    const { fake, memory } = await setup()
    const [entry] = await memory.list()
    if (!entry) throw new Error('no entries')
    const saved = await memory.write(entry.id, '  Studio calendar moved (fixture).  ', {
      confirm: true,
    })
    expect(saved.content).toBe('Studio calendar moved (fixture).')
    expect(saved.id).toBe(
      `memory:memory:0:${fixtureFingerprint('Studio calendar moved (fixture).')}`,
    )
    expect(fake.store.profile('default').memory.memory[0]).toBe(
      'Studio calendar moved (fixture).',
    )
    await expect(memory.read(saved.id)).resolves.toMatchObject({ content: saved.content })
  })

  it('refuses a stale fingerprint: the entry changed after it was read', async () => {
    const { fake, memory } = await setup()
    const [entry] = await memory.list()
    if (!entry) throw new Error('no entries')
    fake.store.profile('default').memory.memory[0] =
      'Changed by the agent meanwhile (fixture).'
    const error = await memory
      .write(entry.id, 'Mine (fixture).', { confirm: true })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'conflict' })
    expect(fake.store.profile('default').memory.memory[0]).toBe(
      'Changed by the agent meanwhile (fixture).',
    )
  })

  it('reports the memory limit without echoing Hermes text', async () => {
    const { memory } = await setup()
    const [, , profileEntry] = await memory.list()
    if (!profileEntry) throw new Error('no profile entry')
    const error = (await memory
      .write(profileEntry.id, 'x'.repeat(1500), { confirm: true })
      .catch((e: unknown) => e)) as CindlError
    expect(error.code).toBe('invalid')
    expect(error.message).toMatch(/of 1,375 characters/)
  })

  it('scrubs host paths from a drift refusal', async () => {
    const { fake, memory } = await setup()
    const [entry] = await memory.list()
    if (!entry) throw new Error('no entries')
    fake.store.profile('default').memory.memory.push('y'.repeat(2300))
    const error = (await memory
      .write(entry.id, 'Edit (fixture).', { confirm: true })
      .catch((e: unknown) => e)) as CindlError
    expect(error.code).toBe('conflict')
    expect(JSON.stringify(error.toJSON())).not.toMatch(/srv|hermes-fixture|\.bak/)
  })

  it('maps a wrong profile to not-found and an invalid profile name to invalid', async () => {
    const { memory } = await setup()
    expect(await codeOf(memory.list('ghost'))).toBe('not-found')
    expect(await codeOf(memory.list('Not A Profile'))).toBe('invalid')
  })

  it('refuses positional and skill ids before any request', async () => {
    const { memory, writes } = await setup()
    for (const id of [
      'memory:memory:0',
      'memory:profile:2',
      'fixture-notes',
      'memory:other:0:abcdefabcdef',
    ])
      expect(await codeOf(memory.write(id, 'x', { confirm: true }))).toBe('invalid')
    expect(await codeOf(memory.delete('fixture-notes', { confirm: true }))).toBe(
      'invalid',
    )
    expect(await codeOf(memory.read('memory:memory:1'))).toBe('invalid')
    expect(writes()).toEqual([])
    expect(() => parseMemoryEntryId('memory:memory:0')).toThrow(/out of date/)
  })

  it('requires confirmation and refuses empty text', async () => {
    const { memory, writes } = await setup()
    const [entry] = await memory.list()
    if (!entry) throw new Error('no entries')
    expect(await codeOf(memory.write(entry.id, '   ', { confirm: true }))).toBe('invalid')
    expect(
      await codeOf(memory.write(entry.id, 'x', { confirm: false as unknown as true })),
    ).toBe('invalid')
    expect(writes()).toEqual([])
  })

  it('deletes permanently (Hermes keeps no backup)', async () => {
    const { fake, memory } = await setup()
    const entries = await memory.list()
    const last = entries.at(-1)
    if (!last) throw new Error('no entries')
    await expect(memory.delete(last.id, { confirm: true })).resolves.toEqual({
      deleted: true,
    })
    expect(fake.store.profile('default').memory.profile).toEqual([])
    expect(await codeOf(memory.delete(last.id, { confirm: true }))).toBe('conflict')
  })

  it('reports offline when Hermes cannot be reached', async () => {
    const offline = new MemoryEntries({
      rest: new RestClient({
        origin: 'https://hermes.example.test',
        fetch: () => Promise.reject(new TypeError('fetch failed')),
        timers,
        auth: {
          kind: 'bearer',
          accessToken: () => Promise.resolve('synthetic'),
          refresh: () => Promise.resolve(false),
        },
      }),
      sha256Hex,
      now: () => NOW,
    })
    expect(await codeOf(offline.list())).toBe('offline')
  })
})
