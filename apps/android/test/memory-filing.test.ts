/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { forgetDrafts } from '../src/views/drafts.ts'
import {
  BRIEF,
  editTo,
  FOCUS,
  GLAZE,
  HARBOR,
  harness,
  holdListAndReload,
  keptMemoryDrafts,
  keptMemoryKeys,
  KILN,
  lockedNow,
  openEntry,
  releaseList,
  type Entry,
  type Harness,
} from './memoryScreen.tsx'

// Where a draft is filed when a save ends, which key an adoption carries, and
// what a moved-entry lock says about where the draft goes (web e501a97):
// P1d (apps/web/test/memory-drafts.test.tsx) and RT4, RT6, R10 and R11
// (apps/web/test/memory-transport-2.test.tsx, there through the direct
// client and the fake Hermes), ported to Android with the web assertions on the
// rendered screen (./memoryScreen.tsx: the shipped components in jsdom). Writes
// answer like the adapter. SYNTHETIC data only.

afterEach(() => forgetDrafts())

const EXTRA = 'Extra note about the studio van (fictional).'
const HARBOR_MON = 'Harbor Loft (fictional) holds the offsite date until Monday.'
const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'
const D_H = 'Harbor draft: the offsite date moved to Monday (fictional).'
const FRESH = 'Harbor fresh draft: the offsite moves to Thursday (fictional).'
const A_NOTE = 'Archive shelf note (fictional).'
const B_NOTE = 'Bench note (fictional).'
const FIVE = [A_NOTE, B_NOTE, KILN, HARBOR, EXTRA]
const ADOPT = 'Use this draft for the entry now here'
const OFFER = 'An unsaved draft for this is kept on this device:'

/** Agent notes as given, the fixture's two notes about you, adapter-like writes. */
const setup = (memory: string[] = [GLAZE, KILN, HARBOR]) =>
  harness(
    [
      ...memory.map((content): Entry => ({ store: 'memory', content })),
      { store: 'profile', content: BRIEF },
      { store: 'profile', content: FOCUS },
    ],
    { adapterWrites: true },
  )

/** Locks the open editor by changing the agent notes while a held list reload is out. */
async function lockWith(h: Harness, memory: string[], edit?: string) {
  await holdListAndReload(h)
  if (edit !== undefined) {
    h.press('Edit')
    h.change(edit)
  }
  h.mem.set('memory', memory)
  await releaseList(h)
  expect(lockedNow(h)).toBe(true)
}

/** Harbor's own draft kept; a kiln draft used for Harbor and discarded; notes end [Bench, Harbor, Extra]. */
async function harborOffered(h: Harness) {
  await openEntry(h, /Harbor Loft/)
  await lockWith(h, [B_NOTE, KILN, HARBOR, EXTRA], D_H)
  h.press(/Close memory entry/)
  await h.settle()
  await openEntry(h, /The kiln firing log/)
  await lockWith(h, [B_NOTE, HARBOR, EXTRA], D_K)
  h.press(ADOPT)
  await h.settle()
  expect(lockedNow(h)).toBe(false)
  h.press('Discard changes')
  await h.settle()
  expect(h.hasText(OFFER)).toBe(true)
}

describe('a save or conflict acts on where the draft is filed when it ends', () => {
  it('P1d: a list reload that lands while a save is in flight (after Hermes applied it) leaves no kept copy of the saved text', async () => {
    const h = setup()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', D_K)
    h.press('Review changes')
    h.holdAnswer('memory.write')
    h.press('Confirm and save')
    await h.settle()
    // Hermes applied the write; its answer is slow. The list asked earlier is answered now.
    await releaseList(h)
    const during = { locked: lockedNow(h), kept: keptMemoryKeys() }
    h.release('memory.write')
    await h.settle()
    const saved = {
      locked: lockedNow(h),
      kept: keptMemoryDrafts(),
      restore: Boolean(h.button('Restore previous version')),
    }
    h.press(/Close memory entry/)
    await h.settle()
    const closed = { unsaved: h.hasText('Unsaved drafts') }
    expect(during.locked).toBe(true)
    expect(during.kept).toHaveLength(1)
    expect(h.mem.has(/Kiln draft/)).toBe(true)
    expect(saved.kept).toEqual([])
    expect(closed.unsaved).toBe(false)
  })

  it('RT4: a list reload answered after Hermes applied a save, but before the save answer, leaves no kept copy of the saved text', async () => {
    const h = setup()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    h.press('Edit')
    h.change(D_K)
    h.press('Review changes')
    h.holdAnswer('memory.write')
    h.press('Confirm and save')
    await h.settle()
    expect(h.mem.store('memory')[1]).toBe(D_K)
    await releaseList(h)
    const during = { locked: lockedNow(h), keys: keptMemoryKeys() }
    h.release('memory.write')
    await h.settle()
    expect(h.button('Restore previous version')).toBeDefined()
    const saved = {
      locked: lockedNow(h),
      kept: keptMemoryDrafts(),
      store: h.mem.store('memory'),
    }
    h.press(/Close memory entry/)
    await h.settle()
    const closed = { unsaved: h.hasText('Unsaved drafts') }
    expect(during.locked).toBe(true)
    expect(during.keys).toHaveLength(1)
    expect(saved.store).toEqual([GLAZE, D_K, HARBOR])
    expect(saved.kept).toEqual([])
    expect(closed.unsaved).toBe(false)
  })

  it('a conflict that ends after the lock filed the draft keeps it once, where the lock filed it', async () => {
    // Android addition (the web review's RT8): no draft kept twice.
    const h = setup(FIVE)
    await harborOffered(h)
    await holdListAndReload(h)
    h.press('Edit')
    h.change(FRESH)
    h.press('Review changes')
    h.hold('memory.write')
    h.press('Confirm and save')
    await h.settle()
    // Elsewhere Harbor is rewritten; the list answers, and the editor locks.
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    h.release('memory.write')
    await h.settle()
    expect(h.alerts().join(' ')).toMatch(/changed since you read it/)
    const keys = keptMemoryKeys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(`${keys[0]}#2`)
    expect(keptMemoryDrafts()).toEqual([D_H, FRESH])
  })
})

describe('an adoption carries the key the draft is kept under', () => {
  it("RT6 (P1c): that fresh edit used for the entry now here (Harbor removed): no note claims Harbor's draft is Extra's", async () => {
    const h = setup(FIVE)
    await harborOffered(h)
    await holdListAndReload(h)
    h.press('Edit')
    h.change(FRESH)
    h.mem.set('memory', [B_NOTE, EXTRA])
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    h.press(ADOPT)
    await h.settle()
    expect(lockedNow(h)).toBe(false)
    const another = h.hasText(/Another unsaved draft for this is kept on this device/)
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.mem.store('memory')[1]).toBe(FRESH)
    expect(h.button('Restore previous version')).toBeDefined()
    const saved = { kept: keptMemoryDrafts() }
    expect(saved.kept).toEqual([D_H])
    expect(another).toBe(false)
  })
})

describe('a moved-entry lock says where the text in the box goes', () => {
  it("R10: a fresh edit kept beside Harbor's own draft, then Harbor moves up: the lock says it waits under Unsaved drafts, and it does, while Harbor's own draft returns with Harbor", async () => {
    const h = setup(FIVE)
    await harborOffered(h)
    await holdListAndReload(h)
    h.press('Edit')
    h.change(FRESH)
    h.mem.set('memory', [HARBOR, EXTRA])
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    const hint = h.alerts()
    const keys = keptMemoryKeys()
    h.press(/Close memory entry/)
    await h.settle()
    const closed = {
      unsaved: h.hasText('Unsaved drafts'),
      fresh: h.body().includes(FRESH),
    }
    await openEntry(h, /Harbor Loft/)
    const reopened = { box: h.field()?.value }
    expect(hint.join(' ')).toMatch(
      /The same text is now agent note 1\. The text you were editing is kept apart from that entry's own draft, so when you close this it stays under Unsaved drafts\./,
    )
    expect(hint.join(' ')).not.toMatch(/open it there/)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(`${keys[0]}#2`)
    expect(closed).toEqual({ unsaved: true, fresh: true })
    expect(reopened.box).toBe(D_H)
  })

  it('R11: a draft used for Harbor while its own entry is still listed; Harbor moves: the lock says the draft goes back to that entry, and it does', async () => {
    const h = setup(FIVE)
    await openEntry(h, /The kiln firing log/)
    await lockWith(h, [B_NOTE, KILN, HARBOR, EXTRA], D_K)
    // The owner reloads (slow) and uses the draft for Harbor before the list lands; meanwhile Bench is removed.
    h.hold('memory.entries')
    h.press('Reload')
    await h.settle()
    h.press(ADOPT)
    await h.settle()
    expect(lockedNow(h)).toBe(false)
    h.mem.set('memory', [KILN, HARBOR, EXTRA])
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    const hint = h.alerts()
    h.press(/Close/)
    await h.settle()
    const closed = { unsaved: h.hasText('Unsaved drafts'), draft: h.body().includes(D_K) }
    await openEntry(h, /The kiln firing log/)
    const kiln = { box: h.field()?.value ?? null }
    expect(hint.join(' ')).toMatch(
      /This draft was written for agent note 1, so when you close this it goes back to that entry\./,
    )
    expect(hint.join(' ')).not.toMatch(/Unsaved drafts/)
    expect(closed).toEqual({ unsaved: false, draft: false })
    expect(kiln.box).toBe(D_K)
  })
})
