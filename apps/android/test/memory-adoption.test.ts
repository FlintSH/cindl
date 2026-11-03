/** @vitest-environment jsdom */
import {
  CindlError,
  type CindlClientApi,
  type MemoryEntrySummary,
} from '@cindl/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { forgetDrafts } from '../src/views/drafts.ts'
import {
  BRIEF,
  editTo,
  fixtureEntries,
  FOCUS,
  fp,
  GLAZE,
  harness,
  HARBOR,
  holdListAndReload,
  keptMemoryDrafts,
  KILN,
  lockedNow,
  memoryScreen,
  openEntry,
  releaseList,
  type Harness,
  type Store,
} from './memoryScreen.tsx'

// Re-check 5606b13: the reviewer's probes of adoption ("Use this draft for the
// entry now here"), of what a delete confirmation names, and of drafts across
// close, leave and return (apps/web/test/memory-adoption.test.tsx at 85a24f0),
// ported to Android with the web assertions on the rendered screen
// (./memoryScreen.tsx: the shipped components in jsdom).
// Where Android differs, the test says so. Entries with identical text share one
// identity, a documented limit, so the record-only duplicate-text probe is not
// here either. SYNTHETIC data only.

afterEach(() => forgetDrafts())

const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'
const D_H = 'Harbor draft: the offsite date moved to Monday (fictional).'
const MONDAY = 'Harbor Loft (fictional) holds the offsite date until Monday.'
const ZED = 'Zed note about the glaze order (fictional).'
const KEPT =
  'Your unsaved draft was kept. Review it against the current version before saving.'

/** Kiln editor locked by a merge elsewhere (kiln removed, Harbor rewritten), draft D_K in it. */
async function lockedByMerge(h: Harness) {
  await openEntry(h, /The kiln firing log/)
  await holdListAndReload(h)
  editTo(h, 'Edit agent note 2', D_K)
  h.mem.remove(/kiln firing log/)
  h.mem.replace(/Harbor Loft/, MONDAY)
  await releaseList(h)
  expect(lockedNow(h)).toBe(true)
}

/** Kiln draft refused by a merge during review, then locked beside the merged Harbor note. */
async function refusedThenLocked(h: Harness) {
  await openEntry(h, /The kiln firing log/)
  await holdListAndReload(h)
  editTo(h, 'Edit agent note 2', D_K)
  h.press('Review changes')
  h.mem.remove(/kiln firing log/)
  h.mem.replace(/Harbor Loft/, MONDAY)
  h.press('Confirm and save')
  await h.settle()
  expect(h.button('Reload and keep my draft')).toBeDefined()
  await releaseList(h)
  expect(lockedNow(h)).toBe(true)
}

const adopt = async (h: Harness) => {
  h.press('Use this draft for the entry now here')
  await h.settle()
}

describe('adoption ("Use this draft for the entry now here") followed by a further change', () => {
  it('A1: after adopting and saving, the editor is not locked and offers "Restore previous version"', async () => {
    const h = harness()
    await lockedByMerge(h)
    await adopt(h)
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.mem.has(/Kiln draft/)).toBe(true)
    expect(h.alerts().some((a) => /cannot tell which/.test(a))).toBe(false)
    expect(h.button('Restore previous version')).toBeDefined()
    // Android: once saved, the draft is this entry's own; the next edit is not a used draft.
    h.press('Edit')
    expect(h.hasText(/This draft was written for the entry that was here before/)).toBe(
      false,
    )
  })

  it('A2: after adopting, a plain renumbering (an agent note removed) is followed, not locked', async () => {
    // Profile store: the brief is removed and the focus note rewritten elsewhere (a merge).
    const h = harness()
    await openEntry(h, /Prefers a short morning brief/)
    await holdListAndReload(h)
    editTo(h, 'Edit note about you 1', 'Brief draft (fictional).')
    h.mem.remove(/morning brief/)
    h.mem.replace(/Protects focus time/, 'Protects focus time before 11:30 on weekdays.')
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    await adopt(h)
    expect(lockedNow(h)).toBe(false)
    // The owner drops the draft, then reloads while an agent note is removed elsewhere.
    h.press('Discard changes')
    await holdListAndReload(h)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    expect(lockedNow(h)).toBe(false)
    expect(h.button('Edit')).toBeDefined()
  })

  it('A3: when the adoption read fails, the draft is still kept after closing', async () => {
    const h = harness()
    await lockedByMerge(h)
    expect(keptMemoryDrafts()).toContain(D_K)
    h.failNextRead()
    await adopt(h)
    const during = {
      errorShown: h.hasText('Hermes is not answering.'),
      adoptAgain: Boolean(h.button('Use this draft for the entry now here')),
      box: h.field()?.value ?? null,
      kept: keptMemoryDrafts(),
    }
    h.press(/Close memory entry/)
    await h.settle()
    const after = {
      unsavedSection: h.hasText('Unsaved drafts'),
      draftOnScreen: h.body().includes(D_K),
      kept: keptMemoryDrafts(),
    }
    expect(during.errorShown).toBe(true)
    expect(during.adoptAgain).toBe(true)
    expect(during.box).toBe(D_K)
    expect(during.kept).toContain(D_K)
    expect(after.unsavedSection).toBe(true)
    expect(after.kept).toContain(D_K)
    expect(after.draftOnScreen).toBe(true)
  })

  it('A3b: closing while the adoption read is still in flight keeps the draft', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.hold('memory.read')
    await adopt(h)
    h.press(/Close memory entry/)
    await h.settle()
    h.release('memory.read')
    await h.settle()
    expect(keptMemoryDrafts()).toContain(D_K)
    expect(h.hasText('Unsaved drafts')).toBe(true)
    expect(h.body()).toContain(D_K)
  })

  it('A3c: a failed adoption read is reported, not silent', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.failNextRead()
    await adopt(h)
    expect(h.hasText('Hermes is not answering.')).toBe(true)
  })

  it('A3d: a failed adoption leaves the editor bound to its entry, so a renumbering after it does not unlock it', async () => {
    // Android addition: the editor changes entry only when an adoption completes.
    const h = harness()
    await openEntry(h, /Prefers a short morning brief/)
    await holdListAndReload(h)
    editTo(h, 'Edit note about you 1', 'Brief draft (fictional).')
    h.mem.remove(/morning brief/)
    h.mem.replace(/Protects focus time/, 'Protects focus time before 11:30 on weekdays.')
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    h.failNextRead()
    await adopt(h)
    expect(h.hasText('Hermes is not answering.')).toBe(true)
    // Elsewhere an agent note is removed: the note at this place gets a new number.
    h.mem.remove(/Glaze supplier/)
    h.press('Reload')
    await h.settle()
    expect(lockedNow(h)).toBe(true)
    expect(h.field()).toMatchObject({ value: 'Brief draft (fictional).', readOnly: true })
    expect(h.button('Delete entry…')).toBeUndefined()
  })

  it('A4: adopting onto an entry that holds its own kept draft does not silently drop that draft', async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    // 1. A Harbor draft is kept: Glaze is removed, so Extra takes Harbor's place 3.
    await openEntry(h, /Harbor Loft/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    h.press(/Close memory entry/)
    await h.settle()
    expect(keptMemoryDrafts()).toContain(D_H)
    // 2. A kiln draft is kept: kiln (now place 1) is removed, so Harbor takes place 1.
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 1', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    // 3. The owner uses the kiln draft for Harbor, now at place 1.
    await adopt(h)
    const adopted = {
      box: h.field()?.value ?? null,
      keptNotice: h.hasText(/Your unsaved draft was kept/),
      ownDraftNote: h.hasText(/This entry also has an unsaved draft of its own/),
    }
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    h.press(/Close memory entry/)
    await h.settle()
    expect(adopted.box).toBe(D_K)
    expect(adopted.keptNotice).toBe(false)
    expect(adopted.ownDraftNote).toBe(true)
    expect(keptMemoryDrafts()).toContain(D_H)
    // Harbor's text was replaced by the save, so its own draft is listed to copy.
    expect(h.hasText('Unsaved drafts')).toBe(true)
    expect(h.body()).toContain(D_H)
  })

  it('A5: a list change during the adoption read does not unlock the editor beside another entry, and a delete names what it deletes', async () => {
    const h = harness()
    await refusedThenLocked(h)
    // Locked, with the conflict still showing: the owner reloads and adopts at once.
    h.hold('memory.entries')
    h.press('Reload and keep my draft')
    await h.settle()
    h.hold('memory.read')
    await adopt(h)
    // Elsewhere: Glaze removed and a new note appended, so place 2 now holds "Zed".
    h.mem.remove(/Glaze supplier/)
    h.mem.add('memory', ZED)
    await releaseList(h)
    h.release('memory.read')
    await h.settle()
    let confirmText: string | undefined
    if (h.button('Delete entry…')) {
      h.press('Delete entry…')
      confirmText = h.dialog('Delete this memory entry?')
      h.press('Delete permanently')
      await h.settle()
    }
    if (confirmText) {
      const deletedHarbor = !h.mem.has(/until Monday/)
      const namedHarbor = /Delete “Harbor Loft/.test(confirmText)
      expect(deletedHarbor === namedHarbor).toBe(true)
    }
    expect(h.mem.has(/Zed note/)).toBe(true)
    expect(lockedNow(h)).toBe(true)
  })

  it('A6: adopting during review does not confirm a diff reviewed against the old entry', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', D_K)
    h.press('Review changes')
    h.mem.remove(/kiln firing log/)
    h.mem.replace(/Harbor Loft/, MONDAY)
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    await adopt(h)
    const confirm = h.button('Confirm and save')
    expect(confirm === undefined || confirm.disabled).toBe(true)
    expect(h.writes()).toHaveLength(0)
    h.press('Back to editing')
    h.press('Review changes')
    expect(h.changes()).toContain('until Monday')
    h.press('Confirm and save')
    await h.settle()
    expect(h.writes().map((w) => w.id.split(':')[3])).toEqual([fp(MONDAY)])
  })
})

describe('adoption keeps every draft until the owner saves or discards it', () => {
  it('R1: edits made after adopting stay kept for the entry the draft was written for when the editor closes unsaved', async () => {
    const h = harness()
    await lockedByMerge(h)
    await adopt(h)
    expect(lockedNow(h)).toBe(false)
    const more = `${D_K} One more line (fictional).`
    h.change(more)
    await h.settle()
    h.press(/Close memory entry/)
    await h.settle()
    expect(keptMemoryDrafts()).toEqual([more])
    expect(h.hasText('Unsaved drafts')).toBe(true)
    expect(h.body()).toContain(more)
    expect(h.writes()).toHaveLength(0)
  })

  it('R2: an adoption refused because the place changed says so, keeps the draft, and can be retried onto the entry now there', async () => {
    const h = harness()
    await refusedThenLocked(h)
    h.hold('memory.entries')
    h.press('Reload and keep my draft')
    await h.settle()
    h.hold('memory.read')
    await adopt(h)
    // Android has no role="status": the busy line is a polite live region.
    expect(h.polite()).toEqual(['Reading the entry now here…'])
    expect(lockedNow(h)).toBe(true)
    expect(h.button('Delete entry…')).toBeUndefined()
    expect(h.button('Use this draft for the entry now here')?.disabled).toBe(true)
    h.mem.remove(/Glaze supplier/)
    h.mem.add('memory', ZED)
    await releaseList(h)
    h.release('memory.read')
    await h.settle()
    expect(lockedNow(h)).toBe(true)
    expect(h.alerts()).toContain(
      'The entry at this place changed again while Cindl read it.',
    )
    // The adopt button is described by the entry it would use the draft for.
    expect(h.button('Use this draft for the entry now here')?.hint).toMatch(
      /Now at this place: “Zed note about the glaze order/,
    )
    expect(keptMemoryDrafts()).toContain(D_K)
    // The owner retries, now for the entry at this place.
    await adopt(h)
    expect(lockedNow(h)).toBe(false)
    expect(h.field()?.value).toBe(D_K)
    expect(h.hasText(/This draft was written for the entry that was here before/)).toBe(
      true,
    )
    // R3: discarding it forgets it, and later edits here are this entry's own.
    h.press('Discard changes')
    await h.settle()
    expect(keptMemoryDrafts()).not.toContain(D_K)
    editTo(h, 'Edit agent note 2', 'A new note for Zed (fictional).')
    h.press(/Close memory entry/)
    await h.settle()
    expect(keptMemoryDrafts()).toEqual([])
    expect(h.writes().map((w) => w.id.split(':')[3])).toEqual([fp(KILN)])
    expect(h.deletes()).toHaveLength(0)
    expect(h.mem.has(/Zed note/)).toBe(true)
  })

  it('AB: adopting back onto the entry the draft was written for makes it that entry own draft again', async () => {
    // Android addition: the web model's rule (completeAdoption), without a web probe.
    const BISQUE = 'Bisque firings moved to the small kiln (fictional).'
    const h = harness()
    await openEntry(h, /Harbor Loft/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 3', D_H)
    // Elsewhere, Harbor is removed and a Bisque note added in its place.
    h.mem.remove(/Harbor Loft/)
    h.mem.add('memory', BISQUE)
    await releaseList(h)
    expect(lockedNow(h)).toBe(true)
    await adopt(h)
    expect(h.hasText(/This draft was written for the entry that was here before/)).toBe(
      true,
    )
    // The save is refused: Bisque went and the Harbor note came back at the place.
    h.press('Review changes')
    h.mem.remove(/Bisque firings/)
    h.mem.add('memory', HARBOR)
    h.press('Confirm and save')
    await h.settle()
    h.press('Reload and keep my draft')
    await h.settle()
    expect(lockedNow(h)).toBe(true)
    expect(h.button('Use this draft for the entry now here')?.hint).toMatch(
      /Now at this place: “Harbor Loft/,
    )
    // Used for its own entry again, the draft is that entry's own kept draft.
    await adopt(h)
    expect(lockedNow(h)).toBe(false)
    expect(h.field()?.value).toBe(D_H)
    expect(h.polite()).toEqual([KEPT])
    expect(h.hasText(/This draft was written for the entry that was here before/)).toBe(
      false,
    )
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.writes().map((w) => w.id.split(':')[3])).toEqual([fp(BISQUE), fp(HARBOR)])
    expect(h.mem.has(/Harbor draft/)).toBe(true)
    expect(keptMemoryDrafts()).toEqual([])
  })
})

describe('an editor only ever shows the entry it was opened for, or the one the owner chose', () => {
  it('R4: reloading after another entry moved into the place never reads that entry', async () => {
    const h = harness()
    h.failNextRead()
    await openEntry(h, /The kiln firing log/)
    expect(h.hasText('Hermes is not answering.')).toBe(true)
    // The owner reloads; the list answers after another entry moved into the place.
    h.failNextRead()
    h.hold('memory.entries')
    h.press('Reload')
    await h.settle()
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    h.press('Reload')
    await h.settle()
    const read = h.calls
      .filter((c) => c.name === 'memory.read')
      .map((c) => (c.args as { id: string }).id.split(':')[3])
    expect(read).not.toContain(fp(HARBOR))
    expect(h.hasText('Another entry is at this place now.')).toBe(true)
    expect(h.button('Delete entry…')).toBeUndefined()
    expect(h.field()).toBeUndefined()
  })

  it('R5: a read of the old entry that lands after an adoption locks the editor until the entry now here is read again', async () => {
    const LATE = 'Late note about the studio keys (fictional).'
    const D_F = 'Focus draft: protect focus time before 12:00 (fictional).'
    const summary = (id: string, content: string): MemoryEntrySummary => ({
      id,
      store: id.split(':')[1] as Store,
      title: content,
      preview: content,
      truncated: false,
    })
    const glaze = `memory:memory:0:${fp(GLAZE)}`
    const brief = (i: number) => `memory:profile:${i}:${fp(BRIEF)}`
    const focus = (i: number) => `memory:profile:${i}:${fp(FOCUS)}`
    const late = `memory:profile:1:${fp(LATE)}`
    // Reads resolve by exact id, so the stale id of the focus note still reads it.
    const contents = new Map([
      [glaze, GLAZE],
      [brief(1), BRIEF],
      [brief(0), BRIEF],
      [focus(2), FOCUS],
      [focus(1), FOCUS],
      [focus(0), FOCUS],
      [late, LATE],
    ])
    let listed = [
      summary(glaze, GLAZE),
      summary(brief(1), BRIEF),
      summary(focus(2), FOCUS),
    ]
    let heldRead: string | undefined
    let releaseRead: (() => void) | undefined
    let conflictNextWrite = false
    const writes: string[] = []
    const call = (async (name: string, args: unknown) => {
      if (name === 'memory.entries') return listed
      if (name === 'memory.read') {
        const { id } = args as { id: string }
        if (id === heldRead) {
          heldRead = undefined
          await new Promise<void>((resolve) => (releaseRead = resolve))
        }
        const content = contents.get(id)
        if (content === undefined) throw new CindlError('conflict', 'Changed.')
        return {
          id,
          store: id.split(':')[1],
          content,
          readAt: '2026-11-03T09:00:00.000Z',
          source: 'test',
        }
      }
      if (name === 'memory.write') {
        writes.push((args as { id: string }).id)
        if (conflictNextWrite) {
          conflictNextWrite = false
          throw new CindlError(
            'conflict',
            'This memory entry changed since you read it. Reload it and review again.',
          )
        }
        throw new Error('no write expected')
      }
      throw new Error(`unexpected call ${name}`)
    }) as CindlClientApi['call']
    const s = memoryScreen({ call })
    await openEntry(s, /Protects focus time/)
    // An agent note is removed: the focus note keeps its place under a new
    // number, and the editor reads it again; that read is slow.
    listed = [summary(brief(0), BRIEF), summary(focus(1), FOCUS)]
    heldRead = focus(1)
    s.press('Reload')
    await s.settle()
    // The owner edits; the save is refused, and the reload finds another note here.
    editTo(s, 'Edit note about you 2', D_F)
    s.press('Review changes')
    conflictNextWrite = true
    s.press('Confirm and save')
    await s.settle()
    listed = [summary(focus(0), FOCUS), summary(late, LATE)]
    s.press('Reload and keep my draft')
    await s.settle()
    expect(lockedNow(s)).toBe(true)
    // The owner uses the draft for the note now here.
    s.press('Use this draft for the entry now here')
    await s.settle()
    expect(lockedNow(s)).toBe(false)
    // The slow read of the focus note lands after that. Until the note now
    // here is read again (held here), the editor is locked: the focus note's
    // text is not this entry's, so nothing can be saved or deleted against it.
    heldRead = late
    const releaseFocusRead = releaseRead
    releaseFocusRead?.()
    await s.settle()
    expect(lockedNow(s)).toBe(true)
    expect(s.button('Delete entry…')).toBeUndefined()
    expect(s.field()?.readOnly).toBe(true)
    expect(keptMemoryDrafts()).toContain(D_F)
    // The note now here is read again, and the editor is bound to it.
    releaseRead?.()
    await s.settle()
    expect(lockedNow(s)).toBe(false)
    s.press('Review changes')
    const changes = s.changes() ?? ''
    expect(changes).toContain(LATE)
    expect(changes).not.toContain(FOCUS)
    s.press('Back to editing')
    s.press('Delete entry…')
    expect(s.dialog('Delete this memory entry?')).toMatch(
      /Delete “Late note about the studio keys/,
    )
    s.press('Keep it')
    expect(writes).toEqual([focus(2)])
  })
})

describe('the delete confirmation names the entry it deletes', () => {
  it('B: a first read answered after the list moved another entry into the place', async () => {
    const h = harness()
    // The owner deletes Glaze; the list reload that follows is slow.
    await openEntry(h, /Glaze supplier/)
    h.press('Delete entry…')
    h.hold('memory.entries')
    h.press('Delete permanently')
    await h.settle()
    // From the stale list, the owner opens the kiln note; its read is slow too.
    h.hold('memory.read')
    h.press(/Open memory entry: The kiln firing log/)
    await h.settle()
    await releaseList(h)
    h.release('memory.read')
    await h.settle()
    const seen = {
      locked: lockedNow(h),
      editorShows: h.shown()?.slice(0, 40) ?? null,
    }
    let confirmText: string | undefined
    if (h.button('Delete entry…')) {
      h.press('Delete entry…')
      confirmText = h.dialog('Delete this memory entry?')
      h.press('Delete permanently')
      await h.settle()
    }
    expect(seen.locked).toBe(true)
    expect(h.button('Edit')).toBeUndefined()
    expect(seen.editorShows).toMatch(/^The kiln firing log/)
    expect(h.alerts().join(' ')).toMatch(/The same text is now agent note 1/)
    if (confirmText) {
      // Whatever was deleted must be what the confirmation named.
      const namedKiln = /Delete “The kiln firing log/.test(confirmText)
      const namedHarbor = /Delete “Harbor Loft/.test(confirmText)
      expect(namedKiln ? !h.mem.has(/kiln firing log/) : true).toBe(true)
      expect(namedHarbor ? !h.mem.has(/Harbor Loft/) : true).toBe(true)
      expect(namedHarbor && h.mem.has(/Harbor Loft/)).toBe(false)
    }
  })

  it('C: right after the owner saves (list still loading), the confirmation names the saved text', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    editTo(h, 'Edit agent note 2', D_K)
    h.press('Review changes')
    h.hold('memory.entries')
    h.press('Confirm and save')
    await h.settle()
    h.press('Delete entry…')
    const confirmText = h.dialog('Delete this memory entry?') ?? ''
    h.press('Keep it')
    expect(confirmText).toMatch(/Delete “Kiln draft/)
  })

  it('C2: a delete right after a save deletes the saved text, by the id the save answered', async () => {
    // Android addition: the delete names the id of the text read, not the row's.
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    editTo(h, 'Edit agent note 2', D_K)
    h.press('Review changes')
    h.hold('memory.entries')
    h.press('Confirm and save')
    await h.settle()
    h.press('Delete entry…')
    h.press('Delete permanently')
    await h.settle()
    expect(h.deletes().map((d) => d.id.split(':')[3])).toEqual([fp(D_K)])
    expect(h.mem.has(/Kiln draft/)).toBe(false)
    expect(h.mem.has(/kiln firing log/)).toBe(false)
  })

  it('D4: a confirmation left open while the entry is only renumbered never deletes another entry', async () => {
    const h = harness()
    await openEntry(h, /Prefers a short morning brief/)
    // Android: the confirmation is a modal dialog, so the owner cannot press
    // Reload under it; the reload starts first and answers while it is open.
    await holdListAndReload(h)
    h.press('Delete entry…')
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    const stillOpen = Boolean(h.button('Delete permanently'))
    if (!stillOpen) h.press('Delete entry…')
    const confirmText = h.dialog('Delete this memory entry?') ?? ''
    h.press('Delete permanently')
    await h.settle()
    expect(confirmText).toMatch(/Delete “Prefers a short morning brief/)
    expect(h.deletes().map((d) => d.id.split(':')[3])).toEqual([fp(BRIEF)])
    expect(h.mem.has(/Protects focus time/)).toBe(true)
  })

  it('D4b: an open confirmation closes when the entry read under it changes', async () => {
    // Android addition: DeleteEntry is keyed by the id it deletes.
    const h = harness()
    await openEntry(h, /Prefers a short morning brief/)
    await holdListAndReload(h)
    h.press('Delete entry…')
    expect(h.dialog('Delete this memory entry?')).toBeDefined()
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    expect(h.dialog('Delete this memory entry?')).toBeUndefined()
    expect(h.deletes()).toHaveLength(0)
  })
})

describe('drafts across close, leave and return, moves and removals', () => {
  it('D2: an entry moved up with nothing at its old place keeps its draft, which returns only to it', async () => {
    const h = harness()
    await openEntry(h, /Harbor Loft/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    const vanished = {
      removedLabel: h.hasText('No longer at this place'),
      harborStillListed: h.mem.has(/Harbor Loft/),
    }
    h.press('Close the entry no longer at this place')
    await h.settle()
    const closed = { unsavedSection: h.hasText('Unsaved drafts') }
    await openEntry(h, /Harbor Loft/)
    const reopened = {
      box: h.field()?.value ?? null,
      label: h.field()?.label ?? null,
      notice: h.polite(),
    }
    // The entry now at place 1 (kiln) opens clean.
    h.press(/Close memory entry: Harbor/)
    await openEntry(h, /The kiln firing log/)
    const kiln = { box: h.field()?.value ?? null }
    expect(vanished.removedLabel).toBe(true)
    expect(vanished.harborStillListed).toBe(true)
    expect(closed.unsavedSection).toBe(false)
    expect(reopened.box).toBe(D_H)
    expect(kiln.box).toBeNull()
    // Android: the kept-draft note is neutral (no conflict happened here).
    expect(reopened.label).toBe('Edit agent note 2')
    expect(reopened.notice).toEqual([KEPT])
  })

  it('D3: two kept drafts for two removed entries are both listed, and discarding one keeps the other', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    h.press(/Close memory entry/)
    await h.settle()
    await openEntry(h, /Harbor Loft/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', D_H)
    h.mem.remove(/Harbor Loft/)
    await releaseList(h)
    h.press('Close the entry no longer at this place')
    await h.settle()
    const discards = h.buttons(/^Discard draft/)
    const both = [D_K, D_H].map((d) => h.body().includes(d))
    h.press(/^Discard draft/)
    await h.settle()
    const left = [D_K, D_H].map((d) => h.body().includes(d))
    expect(discards).toHaveLength(2)
    expect(both).toEqual([true, true])
    expect(new Set(discards.map((b) => b.name)).size).toBe(2)
    expect(left.filter(Boolean)).toHaveLength(1)
    expect(h.writes()).toHaveLength(0)
  })

  it('G: leaving the page while a locked editor is open keeps its draft for the list', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.remount()
    await h.settle()
    expect(h.hasText('Unsaved drafts')).toBe(true)
    expect(h.body().includes(D_K)).toBe(true)
  })

  it('I: an emptied store keeps the row until closed, then the draft is listed and the store heading goes', async () => {
    const h = harness(fixtureEntries.filter((e) => e.store === 'memory'))
    await openEntry(h, /Harbor Loft/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 3', D_H)
    h.mem.remove(/Glaze/)
    h.mem.remove(/kiln/)
    h.mem.remove(/Harbor/)
    await releaseList(h)
    const vanished = {
      row: h.hasText('No longer at this place'),
      box: h.field()?.value ?? null,
    }
    h.press('Close the entry no longer at this place')
    await h.settle()
    const closed = {
      heading: h.hasText('Agent notes'),
      unsaved: h.hasText('Unsaved drafts'),
      draft: h.body().includes(D_H),
    }
    expect(vanished.row).toBe(true)
    expect(vanished.box).toBe(D_H)
    expect(closed.heading).toBe(false)
    expect(closed.unsaved).toBe(true)
    expect(closed.draft).toBe(true)
  })

  it("N9b: the owner's save racing the removal of the very entry saved shows the replaced text", async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    editTo(h, 'Edit agent note 2', D_K)
    h.press('Review changes')
    h.hold('memory.entries')
    h.press('Confirm and save')
    await h.settle()
    // Elsewhere the agent removes the note the owner just saved.
    h.mem.remove(/Kiln draft/)
    await releaseList(h)
    expect(h.body().includes(KILN)).toBe(true)
    expect(h.button('Restore previous version')).toBeUndefined()
  })
})

describe('sign-out', () => {
  it('forgets kept memory drafts', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.press(/Close memory entry/)
    await h.settle()
    expect(keptMemoryDrafts()).toContain(D_K)
    // Android: Agent, This device, "Sign out on this device" calls forgetDrafts()
    // once Hermes signed out (src/agent/AgentView.tsx); the screen is left for it.
    h.unmount()
    forgetDrafts()
    h.remount()
    await h.settle()
    expect(keptMemoryDrafts()).toEqual([])
    expect(h.body().includes(D_K)).toBe(false)
  })
})
