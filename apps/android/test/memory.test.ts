import { sha256Hex } from '@cindl/client-core'
import { CindlError, parseOpArgs, type MemoryEntrySummary } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { describe, expect, it } from 'vitest'
import {
  DELETE_REFUSED,
  DELETE_UNCERTAIN,
  entryAt,
  entryName,
  memoryDelete,
  memoryDocument,
  memoryEntryName,
  memoryWrite,
  placeOf,
} from '../src/library/memory.ts'
import { describeFailure } from '../src/talk/failures.ts'

const summary = (id: string, store: 'memory' | 'profile'): MemoryEntrySummary => ({
  id,
  store,
  title: id,
  preview: id,
  truncated: false,
})

describe('memory entry places', () => {
  // Hermes numbers ids across both stores; the screen names entries by their place in one.
  const entries = [
    summary('memory:memory:0:aaaaaaaaaaaa', 'memory'),
    summary('memory:memory:1:bbbbbbbbbbbb', 'memory'),
    summary('memory:profile:2:cccccccccccc', 'profile'),
  ]

  it('names an entry by its place in its store, not by its Hermes index', () => {
    expect(placeOf(entries, 'memory:profile:2:cccccccccccc')).toEqual({
      store: 'profile',
      index: 0,
    })
    expect(memoryEntryName('profile', 1)).toBe('note about you 1')
    expect(memoryEntryName('memory', 2)).toBe('agent note 2')
    expect(placeOf(entries, 'memory:memory:9:dddddddddddd')).toBeUndefined()
  })

  it('follows a place across a save that gives the entry a new id', () => {
    const place = placeOf(entries, 'memory:memory:1:bbbbbbbbbbbb')
    if (!place) throw new Error('place not found')
    const saved = [
      entries[0],
      summary('memory:memory:1:eeeeeeeeeeee', 'memory'),
      entries[2],
    ]
    expect(entryAt(saved as MemoryEntrySummary[], place)?.id).toBe(
      'memory:memory:1:eeeeeeeeeeee',
    )
  })
})

describe('an entry with no title in words (review 1b8252ea, S5)', () => {
  const entry = (title: string, preview: string): MemoryEntrySummary => ({
    ...summary('memory:memory:0:aaaaaaaaaaaa', 'memory'),
    title,
    preview,
  })

  it('is named by its first words when its title is only spaces, else by its place', () => {
    expect(entryName(entry('  \t ', '##\nKiln shelves rotate in May.'), 1)).toBe(
      'Kiln shelves rotate in May.',
    )
    expect(entryName(entry(' ', '###\n#'), 3)).toBe('agent note 3')
    expect(entryName(entry('Kiln shelves', 'Kiln shelves rotate in May.'), 1)).toBe(
      'Kiln shelves',
    )
  })
})

describe('memory edits and deletes go to the entry that was read', () => {
  const start = async () => {
    const client = createScenarioClient({ speed: 0 })
    const entries = await client.call('memory.entries', {})
    const second = entries[1]
    if (!second) throw new Error('the scenario has no second memory entry')
    return { client, entries, read: await client.call('memory.read', { id: second.id }) }
  }

  it('reviews against the read text, whose hash is the id fingerprint', async () => {
    const { read } = await start()
    const document = memoryDocument(read, 2)
    expect(document.key).toBe('agent note 2')
    expect(document.content).toBe(read.content)
    expect(document.version).toBe(sha256Hex(read.content.trim()))
    expect(read.id.endsWith(`:${document.version.slice(0, 12)}`)).toBe(true)
  })

  it('is refused when the entry changed after it was read, and never sent with another id', async () => {
    const { client, read } = await start()
    // Another Hermes surface edits the entry after this device read it.
    await client.call('memory.write', {
      id: read.id,
      content: 'Changed on another device (fictional).',
      confirm: true,
    })
    const args = memoryWrite(read, 'Edited here (fictional).')
    expect(args).toEqual({
      id: read.id,
      content: 'Edited here (fictional).',
      confirm: true,
    })
    await expect(client.call('memory.write', args)).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('deletes by the read id with confirmation, and says plainly why a delete failed', async () => {
    const { client, entries, read } = await start()
    expect(memoryDelete(read)).toEqual({ id: read.id, confirm: true })
    await client.call('memory.delete', memoryDelete(read))
    const after = await client.call('memory.entries', {})
    expect(after).toHaveLength(entries.length - 1)
    // Deleting it again: the entry is gone, so nothing happened and the copy says why.
    const again = await client
      .call('memory.delete', memoryDelete(read))
      .catch((e: unknown) => e)
    expect(describeFailure(again, DELETE_UNCERTAIN, DELETE_REFUSED)).toMatchObject({
      certain: true,
    })
    expect(
      describeFailure(
        new CindlError('timeout', 'Lost.'),
        DELETE_UNCERTAIN,
        DELETE_REFUSED,
      ),
    ).toEqual({ certain: false, message: DELETE_UNCERTAIN })
  })

  it('cannot name an entry by its position: Hermes ids carry a fingerprint', () => {
    expect(() =>
      parseOpArgs('memory.write', { id: 'memory:memory:1', content: 'x', confirm: true }),
    ).toThrow(/Not sent/)
  })
})

describe('sign-out forgets what was typed', () => {
  it('clears kept document drafts and unsent question answers', async () => {
    const { keptDrafts, forgetDrafts } = await import('../src/views/drafts.ts')
    const { clarifyDraftStore, emptyDraft, withDraft } =
      await import('../src/talk/requests.ts')
    keptDrafts.set('agent note 2', 'A draft about the kiln (fictional).')
    clarifyDraftStore.save('srq-00000000dea2', withDraft({}, 'q0', emptyDraft))
    forgetDrafts()
    expect(keptDrafts.size).toBe(0)
    expect(clarifyDraftStore.load('srq-00000000dea2')).toEqual({})
  })
})
