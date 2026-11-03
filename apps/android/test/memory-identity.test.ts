/** @vitest-environment jsdom */
import type { MemoryEntry, MemoryEntrySummary } from '@cindl/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ADOPTION_MOVED,
  ANOTHER_ENTRY,
  completeAdoption,
  entryEditorView,
  followList,
  guardMemorySave,
  identityOf,
  lockNotice,
  LOCKED_NOTICE,
  memoryDraftKey,
  placeNow,
  readRequest,
  REMOVED_ENTRY,
  rowIsEntry,
  titleOf,
} from '../src/library/memory.ts'
import { forgetDrafts } from '../src/views/drafts.ts'
import {
  ADOPTION_BUSY,
  ADOPTION_NOT_USED,
  draftNotice,
  keptDraft,
  lockPanel,
  RESTORED_DRAFT,
} from '../src/views/editorModel.ts'
import {
  failedRead,
  replaceForKey,
  type ResourceState,
} from '../src/views/useResource.ts'
import {
  editTo,
  fixtureEntries,
  fp,
  HARBOR,
  harness,
  holdListAndReload,
  KILN,
  lockedNow,
  openEntry,
  releaseList,
  type Harness,
} from './memoryScreen.tsx'

// The web reviewer's probes of entry identity (apps/web/test/memory-identity.test.tsx
// at 85a24f0), ported to Android on the rendered screen (./memoryScreen.tsx:
// MemoryEntries.tsx and DocumentEditor.tsx themselves, in jsdom): a draft, a save
// and a delete stay bound to the entry the owner read, and text at a place that
// may be another entry locks the editor instead of being followed.
// SYNTHETIC data only; nothing here talks to Hermes.

afterEach(() => forgetDrafts())

const draft = 'The kiln firing log moved to the studio binder (fictional).'
const harborFp = fp(HARBOR)
const MONDAY = 'Harbor Loft (fictional) holds the offsite date until Monday.'

/** What the owner sees, and what one more Review + Confirm would send. */
async function tryToSave(h: Harness) {
  const box = h.field()
  const seen = {
    alert: h.alerts().map((a) => a.slice(0, 70)),
    keptNotice: h.hasText(/Your unsaved draft was kept/),
    box: box ? { value: box.value.slice(0, 50), readOnly: box.readOnly } : null,
    reviewEnabled: h.button('Review changes')?.disabled === false,
  }
  if (seen.reviewEnabled) {
    h.press('Review changes')
    const confirm = h.button('Confirm and save')
    if (confirm && !confirm.disabled) {
      h.press('Confirm and save')
      await h.settle()
    }
  }
  return seen
}

/** The kiln note edited and reviewed, then removed elsewhere: the save is refused. */
async function conflictAfterRemoval(h: Harness) {
  await openEntry(h, /The kiln firing log/)
  editTo(h, 'Edit agent note 2', draft)
  h.press('Review changes')
  h.mem.remove(/kiln firing log/)
  h.press('Confirm and save')
  await h.settle()
  expect(h.alerts().join(' ')).toMatch(/changed since you read it/)
}

describe('re-check of f7f5925 P3/P4 with the flow the fix allows', () => {
  it('P3a: after the reviewed entry is removed, "Reload and keep my draft" locks and offers nothing as kept', async () => {
    const h = harness()
    await conflictAfterRemoval(h)
    h.press('Reload and keep my draft')
    await h.settle()
    const seen = await tryToSave(h)
    expect(seen.alert.join(' ')).toMatch(/removed or moved in Hermes/)
    expect(seen.keptNotice).toBe(false)
    expect(seen.reviewEnabled).toBe(false)
    expect(h.writes()).toHaveLength(1)
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('P4a: another entry taking the place during editing raises a notice and blocks review', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', draft)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    const seen = await tryToSave(h)
    expect(seen.alert.join(' ')).toMatch(/removed or moved in Hermes/)
    expect(seen.reviewEnabled).toBe(false)
    expect(h.writes()).toHaveLength(0)
  })
})

describe('a kept draft and the editor stay bound to the entry that was read', () => {
  it('N1: after the lock, closing and reopening the place does not offer the kept draft over the entry now there', async () => {
    const h = harness()
    await conflictAfterRemoval(h)
    h.press('Reload and keep my draft')
    await h.settle()
    expect(h.alerts().join(' ')).toMatch(/removed or moved in Hermes/)
    // The lock notice says: close this and open the entry again.
    h.press(/Close memory entry: Harbor Loft/)
    await h.settle()
    h.press(/Open memory entry: Harbor Loft/)
    await h.settle()
    const seen = await tryToSave(h)
    expect(seen.keptNotice).toBe(false)
    expect(seen.box).toBeNull()
    // The only write is the refused first attempt, to the kiln note's own id.
    expect(h.writes()).toHaveLength(1)
    expect(h.writes().some((w) => w.id.endsWith(`:${harborFp}`))).toBe(false)
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('N1b: a draft kept after a conflict is not offered over the entry that later holds its place (close, leave, come back)', async () => {
    const h = harness()
    await conflictAfterRemoval(h)
    h.press(/Close memory entry: The kiln firing log/)
    h.remount()
    await openEntry(h, /Harbor Loft/)
    const seen = await tryToSave(h)
    expect(seen.keptNotice).toBe(false)
    expect(h.writes()).toHaveLength(1)
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('N1d: after the lock, nothing is deleted from the locked editor, and the reopened place shows its own entry', async () => {
    const h = harness()
    await conflictAfterRemoval(h)
    h.press('Reload and keep my draft')
    await h.settle()
    // Locked: no delete is offered for the entry now at the place.
    expect(h.button('Delete entry…')).toBeUndefined()
    h.press(/Close memory entry: Harbor Loft/)
    await h.settle()
    // Closed, the kiln draft is listed for copying, not attached to Harbor Loft.
    expect(h.hasText('Unsaved drafts')).toBe(true)
    expect(h.hasText(draft)).toBe(true)
    h.press(/Open memory entry: Harbor Loft/)
    await h.settle()
    expect(h.field()).toBeUndefined()
    expect(h.shown()).toMatch(/^Harbor Loft \(fictional\) holds the offsite date/)
    h.press('Delete entry…')
    expect(h.dialog('Delete this memory entry?')).toMatch(/Delete “Harbor Loft/)
    h.press('Keep it')
    expect(h.deletes()).toHaveLength(0)
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })
})

describe('text at the place that may be another entry locks the editor', () => {
  /** Elsewhere, the agent merges the kiln note into the Harbor note. */
  const merge = (h: Harness) => {
    h.mem.remove(/kiln firing log/)
    h.mem.replace(/Harbor Loft/, MONDAY)
  }

  it('N2: an entry removed while the next one is rewritten (a merge) locks instead of following the rewritten neighbour', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', draft)
    merge(h)
    await releaseList(h)
    const seen = await tryToSave(h)
    expect(seen.alert.join(' ')).toMatch(/removed or moved in Hermes/)
    expect(seen.box).toEqual({ value: draft.slice(0, 50), readOnly: true })
    expect(h.field()?.label).toBe('Edit agent note 2')
    expect(h.writes()).toHaveLength(0)
    expect(h.mem.has(/until Monday/)).toBe(true)
  })

  it('N2c: the same merge during review, then "Reload and keep my draft"', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    editTo(h, 'Edit agent note 2', draft)
    h.press('Review changes')
    merge(h)
    h.press('Confirm and save')
    await h.settle()
    h.press('Reload and keep my draft')
    await h.settle()
    const seen = await tryToSave(h)
    expect(seen.keptNotice && seen.reviewEnabled).toBe(false)
    expect(seen.keptNotice || seen.reviewEnabled).toBe(false)
    expect(h.writes()).toHaveLength(1)
    expect(h.mem.has(/until Monday/)).toBe(true)
  })

  it('N2d: after the merge, "Delete entry…" from the kiln draft does not delete the rewritten neighbour', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', draft)
    merge(h)
    await releaseList(h)
    expect(h.button('Delete entry…')).toBeUndefined()
    expect(h.deletes()).toHaveLength(0)
    expect(h.mem.has(/until Monday/)).toBe(true)
  })

  it('N3: the last entry removed and a new one added in its place does not receive the old draft silently', async () => {
    const h = harness()
    await openEntry(h, /Harbor Loft/)
    await holdListAndReload(h)
    editTo(
      h,
      'Edit agent note 3',
      'Harbor Loft (fictional) holds the offsite date until Tuesday.',
    )
    h.mem.remove(/Harbor Loft/)
    h.mem.add('memory', 'Bisque firings moved to the small kiln (fictional).')
    await releaseList(h)
    const seen = await tryToSave(h)
    expect(seen.alert.length).toBeGreaterThan(0)
    expect(h.writes()).toHaveLength(0)
    expect(h.mem.has(/Bisque firings/)).toBe(true)
  })

  it('N8: a renumbered entry is followed even when its read fails, and Reload then reads the new id', async () => {
    const h = harness()
    await openEntry(h, /Prefers a short morning brief/)
    await holdListAndReload(h)
    editTo(
      h,
      'Edit note about you 1',
      'Prefers a short morning brief, ready before 08:15.',
    )
    h.mem.remove(/Glaze supplier/)
    h.failNextRead()
    await releaseList(h)
    expect(h.field()?.value).toBe('Prefers a short morning brief, ready before 08:15.')
    expect(h.alerts()).toEqual(['Hermes is not answering.'])
    h.press('Reload')
    await h.settle()
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.mem.has(/08:15/)).toBe(true)
    expect(h.mem.has(/Harbor Loft/) && h.mem.has(/kiln firing log/)).toBe(true)
    // The save named the entry's current id, read after it was renumbered.
    expect(h.writes().map((w) => w.id)).toEqual([
      `memory:profile:2:${fp('Prefers a short morning brief, ready before 08:30.')}`,
    ])
  })
})

describe('a save here', () => {
  it('SV: after a save here, the replaced text coming back at the place locks the editor', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    editTo(h, 'Edit agent note 2', draft)
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(lockedNow(h)).toBe(false)
    // Elsewhere, the save is undone: the kiln note's text is back at its place.
    h.mem.replace(/studio binder/, KILN)
    h.press('Reload')
    await h.settle()
    expect(lockedNow(h)).toBe(true)
    expect(h.button('Edit')).toBeUndefined()
    expect(h.button('Delete entry…')).toBeUndefined()
  })
})

describe('an entry that vanishes keeps its row and draft', () => {
  it('N4: the only entry of a store removed during editing keeps its row and draft', async () => {
    const h = harness(fixtureEntries.filter((e) => !/morning brief/.test(e.content)))
    await openEntry(h, /Protects focus time/)
    await holdListAndReload(h)
    editTo(h, 'Edit note about you 1', 'My unsaved note (fictional).')
    h.mem.remove(/Protects focus time/)
    await releaseList(h)
    expect(h.hasText('No longer at this place')).toBe(true)
    expect(h.field()).toMatchObject({
      label: 'Edit note about you 1',
      value: 'My unsaved note (fictional).',
      readOnly: true,
    })
  })

  it('N4b: the last entry in Hermes removed during editing keeps its row and draft', async () => {
    const h = harness([{ store: 'memory', content: 'Only note (fictional).' }])
    await openEntry(h, /Only note/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 1', 'Only note, edited (fictional).')
    h.mem.remove(/Only note/)
    await releaseList(h)
    expect(h.hasText('No longer at this place')).toBe(true)
    expect(h.field()?.value).toBe('Only note, edited (fictional).')
    h.press('Close the entry no longer at this place')
    expect(h.hasText('No longer at this place')).toBe(false)
  })
})

describe('restore after a save', () => {
  it('N9: when another entry takes the place right after a save, the previous text is still on screen', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    editTo(h, 'Edit agent note 2', draft)
    h.press('Review changes')
    h.hold('memory.entries')
    h.press('Confirm and save')
    await h.settle()
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    expect(h.body()).toContain('The kiln firing log lives in the studio inventory sheet')
    expect(h.alerts().join(' ')).toMatch(/removed or moved in Hermes/)
    // Restoring would write over another entry: the replaced text is only shown.
    expect(h.button('Restore previous version')).toBeUndefined()
  })

  it('offers the replaced text for restore only onto the version the save produced', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    editTo(h, 'Edit agent note 2', draft)
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.button('Restore previous version')).toBeDefined()
  })
})

describe('explicit re-selection', () => {
  it('uses a locked draft for the entry now here only when the owner chooses it', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', draft)
    // A merge elsewhere: the kiln note is removed and Harbor Loft rewritten.
    h.mem.remove(/kiln firing log/)
    h.mem.replace(/Harbor Loft/, MONDAY)
    await releaseList(h)
    expect(h.button('Review changes')?.disabled).toBe(true)
    h.press('Use this draft for the entry now here')
    await h.settle()
    // Bound to the entry now here, the editor offers nothing more to adopt.
    expect(h.button('Use this draft for the entry now here')).toBeUndefined()
    // Now the review compares the draft with the rewritten entry, in full view.
    h.press('Review changes')
    expect(h.changes()).toContain('until Monday')
    h.press('Confirm and save')
    await h.settle()
    expect(h.writes()).toHaveLength(1)
    expect(h.mem.has(/studio binder/)).toBe(true)
    expect(h.mem.has(/until Monday/)).toBe(false)
  })

  it('discards a kept draft from the list only when asked', async () => {
    const h = harness()
    await openEntry(h, /The kiln firing log/)
    await holdListAndReload(h)
    editTo(h, 'Edit agent note 2', draft)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    h.press(/Close memory entry/)
    await h.settle()
    expect(h.hasText(draft)).toBe(true)
    h.remount()
    await h.settle()
    expect(h.hasText(draft)).toBe(true)
    h.press(/^Discard draft/)
    await h.settle()
    expect(h.hasText(draft)).toBe(false)
    expect(h.writes()).toHaveLength(0)
  })
})

describe('the rules the screen is built on', () => {
  const kiln = (index: number) => `memory:memory:${index}:${fp(KILN)}`
  const harbor = (index: number) => `memory:memory:${index}:${harborFp}`
  const bound = { identity: identityOf(kiln(1)), savedFrom: undefined }

  it('names an entry by its store and text, not by its number', () => {
    const before = memoryDraftKey(harbor(2))
    expect(memoryDraftKey(harbor(1))).toBe(before)
    expect(memoryDraftKey(`memory:profile:1:${harborFp}`)).not.toBe(before)
  })

  it('counts the row as this entry by its text, or as the row a save here replaced until the list catches up', () => {
    expect(rowIsEntry(kiln(0), bound)).toBe(true)
    expect(rowIsEntry(harbor(1), bound)).toBe(false)
    expect(rowIsEntry(undefined, bound)).toBe(false)
    const saved = { identity: 'memory:aaaaaaaaaaaa', savedFrom: kiln(1) }
    expect(rowIsEntry(kiln(1), saved)).toBe(true)
    expect(rowIsEntry(kiln(0), saved)).toBe(false)
  })

  it('reads only this entry, never another one at its place', () => {
    expect(readRequest(kiln(1), true)).toEqual({ id: kiln(1) })
    expect(readRequest(harbor(1), false)).toMatchObject({
      code: 'conflict',
      message: ANOTHER_ENTRY,
    })
    expect(readRequest(undefined, false)).toMatchObject({
      code: 'not-found',
      message: REMOVED_ENTRY,
    })
  })

  it('reads the same text again under a new number, clears the save marker once the list moved, and never follows other text', () => {
    const follow = (input: Partial<Parameters<typeof followList>[0]>) =>
      followList({
        rowId: kiln(0),
        savedFrom: undefined,
        rowIsIt: true,
        readId: kiln(1),
        readFailed: false,
        ...input,
      })
    expect(follow({})).toEqual({ clearSavedFrom: false, reread: true })
    expect(follow({ readId: kiln(0), readFailed: true })).toEqual({
      clearSavedFrom: false,
      reread: true,
    })
    expect(follow({ rowId: harbor(1), rowIsIt: false })).toEqual({
      clearSavedFrom: false,
      reread: false,
    })
    // Right after a save here, the row still shows the replaced text: not re-read.
    expect(follow({ rowId: kiln(1), savedFrom: kiln(1) })).toEqual({
      clearSavedFrom: false,
      reread: false,
    })
    expect(follow({ savedFrom: kiln(1) })).toEqual({ clearSavedFrom: true, reread: true })
  })

  it('completes an adoption only for the text read, still at the place, and not onto the draft own entry', () => {
    const from = memoryDraftKey(kiln(1))
    expect(
      completeAdoption({
        targetId: harbor(1),
        readId: harbor(1),
        rowNowId: harbor(1),
        from,
      }),
    ).toEqual({ ok: true, identity: identityOf(harbor(1)), adoptedFrom: from })
    // Another text read, or another entry at the place by the time it answered.
    expect(
      completeAdoption({
        targetId: harbor(1),
        readId: kiln(1),
        rowNowId: harbor(1),
        from,
      }),
    ).toEqual({ ok: false, error: ADOPTION_MOVED })
    expect(
      completeAdoption({
        targetId: harbor(1),
        readId: harbor(1),
        rowNowId: kiln(1),
        from,
      }),
    ).toEqual({ ok: false, error: ADOPTION_MOVED })
    expect(
      completeAdoption({
        targetId: harbor(1),
        readId: harbor(1),
        rowNowId: undefined,
        from,
      }),
    ).toEqual({ ok: false, error: ADOPTION_MOVED })
    // Using a draft for the entry it was written for is not an adoption.
    expect(
      completeAdoption({ targetId: kiln(0), readId: kiln(0), rowNowId: kiln(0), from }),
    ).toEqual({ ok: true, identity: identityOf(kiln(0)), adoptedFrom: undefined })
  })

  it('offers the adoption only while locked and the delete only for the text read, and files a used draft under its own entry', () => {
    const summary = (id: string, title: string): MemoryEntrySummary => ({
      id,
      store: 'memory',
      title,
      preview: title,
      truncated: false,
    })
    const read = (id: string, content: string): MemoryEntry => ({
      id,
      store: 'memory',
      content,
      readAt: '2026-11-03T09:00:00.000Z',
      source: 'probe',
    })
    const base = {
      adoptedFrom: undefined,
      store: 'memory' as const,
      place: 2,
      placeNow: () => undefined,
      kept: () => false,
    }
    const open = entryEditorView({
      ...base,
      binding: bound,
      row: summary(kiln(1), KILN),
      read: read(kiln(1), KILN),
    })
    expect(open).toMatchObject({
      locked: false,
      lockNotice: undefined,
      adoptTarget: undefined,
      draftKey: memoryDraftKey(kiln(1)),
      keepDraft: false,
      draftNote: undefined,
    })
    expect(open.deletes).toEqual({ entry: read(kiln(1), KILN), title: titleOf(KILN) })
    const other = summary(harbor(1), HARBOR)
    const locked = entryEditorView({
      ...base,
      binding: bound,
      row: other,
      read: read(kiln(1), KILN),
    })
    expect(locked).toMatchObject({ locked: true, adoptTarget: other, deletes: undefined })
    expect(locked.nowHere).toBe(HARBOR)
    // A used draft stays filed under the entry it was written for, kept while edited.
    const used = entryEditorView({
      ...base,
      binding: { identity: identityOf(harbor(1)), savedFrom: undefined },
      adoptedFrom: memoryDraftKey(kiln(1)),
      row: other,
      read: read(harbor(1), HARBOR),
      kept: (key) => key === memoryDraftKey(harbor(1)),
    })
    expect(used).toMatchObject({
      locked: false,
      ownKey: memoryDraftKey(harbor(1)),
      draftKey: memoryDraftKey(kiln(1)),
      keepDraft: true,
    })
    expect(used.draftNote).toMatch(/This entry also has an unsaved draft of its own/)
  })

  it('says where the same text is now and names the entry now at the place', () => {
    const summary = (id: string, title: string) => ({
      id,
      store: 'memory' as const,
      title,
      preview: title,
      truncated: false,
    })
    const entries = [summary(kiln(0), KILN), summary(harbor(1), HARBOR)]
    expect(placeNow(entries, identityOf(kiln(0)))).toBe(1)
    expect(placeNow(entries, 'memory:aaaaaaaaaaaa')).toBeUndefined()
    // Two entries with the same text: no single place to name.
    expect(placeNow([...entries, summary(kiln(2), KILN)], identityOf(kiln(0)))).toBe(
      undefined,
    )
    // Where the text in the box goes when the editor closes, by where it is kept.
    const own = memoryDraftKey(harbor(1))
    const notice = (keptAs: string | undefined, movedTo: number | undefined = 1) =>
      lockNotice({
        noun: 'agent note',
        place: 2,
        movedTo,
        keptAs,
        ownKey: own,
        placeNow: (identity) =>
          identity === identityOf(kiln(0))
            ? 3
            : identity === 'profile:bbbbbbbbbbbb'
              ? 1
              : undefined,
      })
    const here = `${LOCKED_NOTICE} The same text is now agent note 1`
    // This entry's own draft (or none yet) returns with the entry.
    expect(notice(undefined)).toBe(
      `${here}; close this and open it there to keep editing it.`,
    )
    expect(notice(own)).toBe(`${here}; close this and open it there to keep editing it.`)
    // A draft kept beside the entry's own draft waits under Unsaved drafts.
    expect(notice(`${own}#2`)).toBe(
      `${here}. The text you were editing is kept apart from that entry's own draft, so when you close this it stays under Unsaved drafts.`,
    )
    // A draft written for another entry goes back to it while it is listed, else waits.
    expect(notice(memoryDraftKey(kiln(1)))).toBe(
      `${here}. This draft was written for agent note 3, so when you close this it goes back to that entry.`,
    )
    expect(notice('memory-draft:profile:bbbbbbbbbbbb')).toBe(
      `${here}. This draft was written for note about you 1, so when you close this it goes back to that entry.`,
    )
    expect(notice('memory-draft:memory:cccccccccccc')).toBe(
      `${here}. This draft was written for another entry, so when you close this it stays under Unsaved drafts.`,
    )
    expect(notice(own, 2)).toBe(LOCKED_NOTICE)
    expect(
      lockNotice({
        noun: 'agent note',
        place: 2,
        movedTo: undefined,
        keptAs: undefined,
        ownKey: own,
        placeNow: () => undefined,
      }),
    ).toBe(LOCKED_NOTICE)
  })

  it('names an entry by the first line with words, cut as Hermes cuts card titles, else "this entry"', () => {
    expect(titleOf('  ## Kiln log\nsecond line')).toBe('Kiln log')
    expect(titleOf('x'.repeat(81))).toBe(`${'x'.repeat(80)}…`)
    expect(titleOf('x'.repeat(80))).toBe('x'.repeat(80))
    // Z3: a first line that is only a heading mark is skipped.
    expect(titleOf('#\nStudio keys are in the blue box (fictional).')).toBe(
      'Studio keys are in the blue box (fictional).',
    )
    expect(titleOf('##\n\n  \n')).toBe('this entry')
  })

  it('keeps a draft while locked or while it is a used draft, and says so neutrally', () => {
    const editing = { kind: 'edit' as const, draft: 'text' }
    expect(keptDraft('locked', false, editing)).toBe('text')
    expect(keptDraft(undefined, true, editing)).toBe('text')
    expect(keptDraft(undefined, false, editing)).toBeUndefined()
    expect(keptDraft('locked', true, { kind: 'view' })).toBeUndefined()
    expect(draftNotice({ draftNote: undefined, restored: true, locked: undefined })).toBe(
      RESTORED_DRAFT,
    )
    expect(draftNotice({ draftNote: 'note', restored: true, locked: undefined })).toBe(
      'note',
    )
    expect(
      draftNotice({ draftNote: 'note', restored: true, locked: 'locked' }),
    ).toBeUndefined()
  })

  it('offers the adoption on a draft only, disabled while its read is out, and reports a refusal', () => {
    const editing = { kind: 'edit' as const, draft: 'text' }
    expect(
      lockPanel({
        locked: undefined,
        canAdopt: true,
        stage: editing,
        adoption: undefined,
        nowHere: 'Zed',
      }),
    ).toBeUndefined()
    // In the view stage (no draft) there is nothing to adopt, and its own Reload serves.
    expect(
      lockPanel({
        locked: 'L',
        canAdopt: true,
        stage: { kind: 'view' },
        adoption: undefined,
        nowHere: 'Zed',
      }),
    ).toMatchObject({ reload: false, adopt: undefined })
    expect(
      lockPanel({
        locked: 'L',
        canAdopt: true,
        stage: editing,
        adoption: { busy: true },
        nowHere: 'Zed',
      }),
    ).toEqual({
      alerts: ['L'],
      note: undefined,
      nowHere: 'Now at this place: “Zed”.',
      busy: ADOPTION_BUSY,
      reload: true,
      adopt: { disabled: true, hint: 'Now at this place: “Zed”.' },
    })
    expect(
      lockPanel({
        locked: 'L',
        canAdopt: true,
        stage: editing,
        adoption: { busy: false, error: 'E' },
        nowHere: undefined,
      }),
    ).toEqual({
      alerts: ['L', 'E'],
      note: ADOPTION_NOT_USED,
      nowHere: undefined,
      busy: undefined,
      reload: true,
      adopt: { disabled: false, hint: undefined },
    })
  })

  it('refuses a save when locked or when the entry read is not the reviewed version', () => {
    expect(() => guardMemorySave(true, 'v1', 'v1')).toThrow(
      /changed since you reviewed it/,
    )
    expect(() => guardMemorySave(false, 'v2', 'v1')).toThrow(
      /changed since you reviewed it/,
    )
    expect(() => guardMemorySave(false, 'v1', 'v1')).not.toThrow()
  })

  it('S2: a late save for another document does not replace what is loaded now', () => {
    const now: ResourceState<string> = {
      key: 'skill:inventory-sheets',
      token: 1,
      data: 'B',
    }
    expect(
      replaceForKey(now, { key: 'skill:calendar-triage', token: 1, data: 'A2' }),
    ).toBe(now)
    expect(
      replaceForKey(now, { key: 'skill:inventory-sheets', token: 1, data: 'B2' }),
    ).toEqual({
      key: 'skill:inventory-sheets',
      token: 1,
      data: 'B2',
    })
  })

  it('keeps what was read beside the error when a re-read fails', () => {
    const read: ResourceState<string> = { key: 'memory:memory:2', token: 1, data: 'kiln' }
    expect(failedRead(read, { key: 'memory:memory:2', token: 2, error: 'down' })).toEqual(
      {
        key: 'memory:memory:2',
        token: 2,
        data: 'kiln',
        error: 'down',
      },
    )
    expect(failedRead(read, { key: 'memory:memory:3', token: 2, error: 'down' })).toEqual(
      {
        key: 'memory:memory:3',
        token: 2,
        error: 'down',
      },
    )
  })
})
