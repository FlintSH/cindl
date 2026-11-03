import { afterEach, describe, expect, it } from 'vitest'
import { titleOf } from '../src/library/memory.ts'
import { forgetDrafts } from '../src/views/drafts.ts'
import {
  editTo,
  fixtureEntries,
  harness,
  holdListAndReload,
  keptMemoryDrafts,
  keptMemoryKeys,
  lockedNow,
  openEntry,
  releaseList,
  shellSession,
  type Entry,
  type Harness,
} from './memoryScreen.ts'

// Re-check de42f21: the reviewer's probes of drafts around an adoption, a
// refused adoption and what a delete names (apps/web/test/memory-drafts.test.tsx
// at 5d0be84), ported to Android on the screen in ./memoryScreen.ts with the web
// assertions. Writes answer like the adapter (same index, new fingerprint), as in
// the web probes. Where Android differs, the test says so. SYNTHETIC data only.

afterEach(() => forgetDrafts())

const HARBOR_MON = 'Harbor Loft (fictional) holds the offsite date until Monday.'
const WEDNESDAY = 'Harbor Loft (fictional) holds the offsite date until Wednesday.'
const TUESDAY = 'Harbor Loft (fictional) holds the offsite date until Tuesday.'
const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'
const D_H = 'Harbor draft: the offsite date moved to Monday (fictional).'
const OFFER = 'An unsaved draft for this is kept on this device:'

/** The fixture with a fourth agent note after Harbor Loft. */
const withExtra = (extra = 'Extra note (fictional).'): Entry[] => [
  ...fixtureEntries.slice(0, 3),
  { store: 'memory', content: extra },
  ...fixtureEntries.slice(3),
]
const drafts = (initial: Entry[] = fixtureEntries) =>
  harness(initial, { adapterWrites: true })

async function lockedByMerge(h: Harness) {
  await openEntry(h, /The kiln firing log/)
  await holdListAndReload(h)
  editTo(h, 'Edit agent note 2', D_K)
  h.mem.remove(/kiln firing log/)
  h.mem.replace(/Harbor Loft/, HARBOR_MON)
  await releaseList(h)
  expect(lockedNow(h)).toBe(true)
}

/**
 * Harbor's own draft kept (Glaze removed under its editor, so Extra took its
 * place), then a kiln draft locked beside Harbor (kiln removed, so Harbor took
 * place 1) and used for it.
 */
async function adoptedOntoHarborWithItsOwnDraft(h: Harness) {
  await openEntry(h, /Harbor Loft/)
  await holdListAndReload(h)
  editTo(h, 'Edit agent note 3', D_H)
  h.mem.remove(/Glaze supplier/)
  await releaseList(h)
  expect(lockedNow(h)).toBe(true)
  h.press(/Close memory entry/)
  await h.settle()
  expect(keptMemoryDrafts()).toContain(D_H)
  await openEntry(h, /The kiln firing log/)
  await holdListAndReload(h)
  editTo(h, 'Edit agent note 1', D_K)
  h.mem.remove(/kiln firing log/)
  await releaseList(h)
  expect(lockedNow(h)).toBe(true)
  h.press('Use this draft for the entry now here')
  await h.settle()
}

/**
 * Opens the delete confirmation, sends the delete (refused by the probe so
 * nothing changes), and reports what was named against what the sent id
 * resolves to in Hermes now.
 */
async function deleteCheck(h: Harness) {
  if (!h.button('Delete entry…')) return { offered: false as const }
  h.press('Delete entry…')
  const text = h.dialog('Delete this memory entry?') ?? ''
  const named = /Delete “(.*)” from Hermes/.exec(text)?.[1] ?? null
  const before = h.deletes().length
  h.state.refuseDeletes = true
  h.press('Delete permanently')
  await h.settle()
  h.state.refuseDeletes = false
  const sent = h.deletes()[before]?.id ?? null
  if (h.button('Keep it')) h.press('Keep it')
  await h.settle()
  const resolved = sent ? (h.mem.resolve(sent)?.content ?? null) : null
  return {
    offered: true as const,
    named,
    sent,
    resolvedTitle: resolved === null ? null : titleOf(resolved),
  }
}

describe('adoption keeps every draft', () => {
  it('X1: after adopting onto an entry with its own kept draft, discarding and saving fresh text does not delete that draft', async () => {
    const h = drafts(withExtra())
    await adoptedOntoHarborWithItsOwnDraft(h)
    const promised = h.hasText(
      /This entry also has an unsaved draft of its own, which stays kept/,
    )
    // Changes their mind: discards the kiln draft, then edits Harbor afresh and saves.
    h.press('Discard changes')
    await h.settle()
    const afterDiscard = {
      kept: keptMemoryDrafts(),
      harborDraftOnScreen: h.body().includes(D_H),
    }
    editTo(h, 'Edit agent note 1', TUESDAY)
    const editing = { box: h.field()?.value }
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    const saved = { kept: keptMemoryDrafts(), writes: h.writes().map((w) => w.content) }
    h.press(/Close memory entry/)
    await h.settle()
    const closed = {
      unsaved: h.hasText('Unsaved drafts'),
      harborDraftOnScreen: h.body().includes(D_H),
    }
    expect(promised).toBe(true)
    // Harbor's own draft is shown, kept, while the box edits afresh, and it outlives the save.
    expect(afterDiscard.kept).toEqual([D_H])
    expect(afterDiscard.harborDraftOnScreen).toBe(true)
    expect(editing.box).toBe(TUESDAY)
    expect(saved.kept).toContain(D_H)
    expect(saved.writes).toEqual([TUESDAY])
    expect(closed.unsaved).toBe(true)
    expect(closed.harborDraftOnScreen).toBe(true)
  })

  it("X1c (control): the same adoption and discard, then close and reopen: the entry's own draft comes back", async () => {
    const h = drafts(withExtra())
    await adoptedOntoHarborWithItsOwnDraft(h)
    h.press('Discard changes')
    await h.settle()
    h.press(/Close memory entry/)
    await h.settle()
    await openEntry(h, /Harbor Loft/)
    expect(h.field()?.value).toBe(D_H)
  })

  it('X2: an adoption refused because the entry now here changed again can be completed from the editor (retry or a reload control)', async () => {
    const h = drafts()
    await lockedByMerge(h)
    // Elsewhere, the agent edits the entry now here once more; the list has not reloaded.
    h.mem.replace(/Harbor Loft/, WEDNESDAY)
    h.press('Use this draft for the entry now here')
    await h.settle()
    const first = {
      kept: keptMemoryDrafts(),
      controls: h.nodes().flatMap((n) => (n.kind === 'button' ? [n.label] : [])),
    }
    h.press('Use this draft for the entry now here')
    await h.settle()
    const second = { locked: lockedNow(h) }
    expect(first.kept).toContain(D_K)
    const reloadOffered = first.controls.some((c) => /Reload/.test(c))
    expect(second.locked === false || reloadOffered).toBe(true)
  })

  it("X7: discarding while the adoption read is out does not file the entry's own text as a draft for the old entry", async () => {
    const h = drafts()
    await lockedByMerge(h)
    h.hold('memory.read')
    h.press('Use this draft for the entry now here')
    await h.settle()
    h.press('Discard changes')
    await h.settle()
    h.release('memory.read')
    await h.settle()
    const s1 = { edit: Boolean(h.button('Edit')) }
    if (s1.edit) h.press('Edit')
    await h.settle()
    const s2 = {
      note:
        h
          .nodes()
          .flatMap((n) =>
            n.kind === 'text' &&
            /This draft was written for the entry that was here before/.test(n.text)
              ? [n.text.slice(0, 60)]
              : [],
          )[0] ?? null,
      kept: keptMemoryKeys(),
    }
    h.press(/Close memory entry/)
    await h.settle()
    const s3 = { kept: keptMemoryDrafts() }
    expect(s2.note).toBeNull()
    expect(s3.kept).toEqual([])
  })

  it('X1b: after an adoption is discarded, Edit shows the entry text under "Your unsaved draft was kept", and the save then forgets that draft', async () => {
    const h = drafts(withExtra())
    await adoptedOntoHarborWithItsOwnDraft(h)
    h.press('Discard changes')
    await h.settle()
    h.press('Edit')
    await h.settle()
    const seen = {
      keptNote: h.hasText(/Your unsaved draft was kept after the conflict/),
      box: h.field()?.value ?? null,
      kept: keptMemoryDrafts(),
    }
    // If the note says a draft was kept, the box holds it.
    expect(seen.keptNote ? seen.box === D_H : true).toBe(true)
    // The same rule with today's wording, which no longer says "after the conflict".
    const keptNoteNow = h.hasText(/^Your unsaved draft was kept\./)
    expect(keptNoteNow ? seen.box === D_H : true).toBe(true)
    expect(seen.kept).toEqual([D_H])
  })

  it('R6: an adoption refused because the entry here changed fetches the list, so trying again uses the entry now here', async () => {
    const h = drafts()
    await lockedByMerge(h)
    h.mem.replace(/Harbor Loft/, WEDNESDAY)
    h.press('Use this draft for the entry now here')
    await h.settle()
    expect(h.alerts().join(' ')).toMatch(/changed since you read it/)
    expect(keptMemoryDrafts()).toContain(D_K)
    // A reload is offered in the locked editor, and the list was already fetched.
    expect(h.buttons('Reload').length).toBeGreaterThan(0)
    h.press('Use this draft for the entry now here')
    await h.settle()
    expect(lockedNow(h)).toBe(false)
    expect(h.field()?.value).toBe(D_K)
    h.press('Review changes')
    expect(h.changes()).toContain('until Wednesday')
    expect(h.writes()).toEqual([])
  })

  it('R7: an adopted draft beside an entry that moved up says it stays under Unsaved drafts, and it does', async () => {
    const h = drafts(withExtra('Extra note about the studio van (fictional).'))
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', D_K)
    h.press('Review changes')
    h.mem.remove(/kiln firing log/)
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    h.press('Confirm and save')
    await h.settle()
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    h.press('Use this draft for the entry now here')
    await h.settle()
    expect(lockedNow(h)).toBe(false)
    // Elsewhere Glaze is removed: the adopted Harbor note moves up a place.
    h.mem.remove(/Glaze supplier/)
    h.press('Reload and keep my draft')
    await h.settle()
    const said = h.alerts().join(' ')
    expect(said).toMatch(
      /The same text is now agent note 1\. This draft was written for another entry, so when you close this it stays under Unsaved drafts/,
    )
    expect(said).not.toMatch(/open it there/)
    h.press(/Close memory entry/)
    await h.settle()
    expect(h.hasText('Unsaved drafts')).toBe(true)
    expect(h.body()).toContain(D_K)
  })

  it('R8: a fresh edit that hits a conflict while the entry has its own kept draft is kept beside it, not over it', async () => {
    const h = drafts(withExtra())
    // A kiln draft is used for Harbor, then discarded: Harbor's own draft is offered.
    await adoptedOntoHarborWithItsOwnDraft(h)
    h.press('Discard changes')
    await h.settle()
    expect(h.hasText(OFFER)).toBe(true)
    // The owner starts afresh instead; the save is refused (Harbor changed elsewhere).
    const FRESH = 'Harbor fresh draft: the offsite moves to Thursday (fictional).'
    editTo(h, 'Edit agent note 1', FRESH)
    expect(h.hasText(/Another unsaved draft for this is kept on this device/)).toBe(true)
    h.press('Review changes')
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    h.press('Confirm and save')
    await h.settle()
    expect(keptMemoryDrafts()).toEqual(expect.arrayContaining([D_H, FRESH]))
    h.press('Reload and keep my draft')
    await h.settle()
    h.press(/Close memory entry/)
    await h.settle()
    expect(h.hasText('Unsaved drafts')).toBe(true)
    expect(h.body()).toContain(D_H)
    expect(h.body()).toContain(FRESH)
    expect(h.deletes()).toEqual([])
  })

  it("R9: discarding a fresh edit leaves the entry's own kept draft, which is offered again", async () => {
    const h = drafts(withExtra())
    await adoptedOntoHarborWithItsOwnDraft(h)
    h.press('Discard changes')
    await h.settle()
    editTo(h, 'Edit agent note 1', 'Harbor afterthought (fictional).')
    h.press('Discard changes')
    await h.settle()
    expect(keptMemoryDrafts()).toEqual([D_H])
    expect(h.hasText(OFFER)).toBe(true)
    h.press('Continue the draft')
    expect(h.field()?.value).toBe(D_H)
    expect(h.writes()).toEqual([])
  })

  it('R9b: a continued draft is that entry own draft: saving it forgets its kept copy, and only that', async () => {
    // Android addition: "Continue the draft" files the box under the slot it came from.
    const h = drafts(withExtra())
    await adoptedOntoHarborWithItsOwnDraft(h)
    h.press('Discard changes')
    await h.settle()
    h.press('Continue the draft')
    expect(h.polite()).toEqual([
      'Your unsaved draft was kept. Review it against the current version before saving.',
    ])
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.writes().map((w) => w.content)).toEqual([D_H])
    expect(keptMemoryDrafts()).toEqual([])
    expect(h.hasText(OFFER)).toBe(false)
  })
})

describe('the delete confirmation names the entry it deletes', () => {
  it('Z3: an entry whose first line is only a heading mark is still named', async () => {
    const h = drafts([
      { store: 'memory', content: '#\nStudio keys are in the blue box (fictional).' },
    ])
    await openEntry(h, /.*/)
    const check = await deleteCheck(h)
    expect(check.offered && check.named).toBeTruthy()
  })
})

describe('TalkBack focus around adoption and locking', () => {
  // Android equivalents of the web's F1 and F2: TalkBack focus is sent by
  // DocumentEditor's effect (memoryScreen records where it went).
  it('F1: a completed adoption sends TalkBack focus into the draft', async () => {
    const h = drafts()
    await lockedByMerge(h)
    h.press('Use this draft for the entry now here')
    await h.settle()
    expect(lockedNow(h)).toBe(false)
    expect(h.focusLog().at(-1)).toBe('draft')
  })

  it('F2: a lock that takes Edit and Delete away sends TalkBack focus to the lock notice', async () => {
    const h = drafts()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    expect(h.button('Delete entry…')).toBeDefined()
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(h.button('Delete entry…')).toBeUndefined()
    expect(h.focusLog()).toEqual(['notice'])
  })
})

describe('SO2: an involuntary sign-out', () => {
  it('forgets kept memory drafts before another sign-in', async () => {
    // Android: AppShell forgets kept drafts when the link reports signed-out
    // (memoryScreen's shellSession runs its effect); the shell is not rendered here.
    const shell = shellSession()
    shell.link({ phase: 'online', demo: false })
    const h = drafts()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    const locked = lockedNow(h)
    h.press(/Close memory entry/)
    await h.settle()
    const keptBefore = keptMemoryDrafts()
    // Hermes refuses the session (token revoked on the host): the client reports
    // signed-out, and the sign-in screen replaces the destinations.
    shell.link({ phase: 'signed-out', demo: false })
    h.unmount()
    const keptAfter = keptMemoryDrafts()
    // Signed in again (to this Hermes or another): nothing comes back.
    shell.link({ phase: 'online', demo: false })
    h.remount()
    await h.settle()
    expect(locked).toBe(true)
    expect(keptBefore).toEqual([D_K])
    expect(keptAfter).toEqual([])
    expect(h.hasText('Unsaved drafts')).toBe(false)
    expect(h.body()).not.toContain(D_K)
  })

  it('the demo has no session to end, so its kept drafts stay', async () => {
    const shell = shellSession()
    shell.link({ phase: 'online', demo: true })
    const h = drafts()
    await lockedByMerge(h)
    h.press(/Close memory entry/)
    await h.settle()
    shell.link({ phase: 'signed-out', demo: true })
    expect(keptMemoryDrafts()).toEqual([D_K])
  })
})
