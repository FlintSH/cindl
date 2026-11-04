/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { MEMORY_DRAFT_PREFIX } from '../src/library/memory.ts'
import { keptDrafts } from '../src/views/drafts.ts'
import {
  BRIEF,
  fixtureEntries,
  fp,
  GLAZE,
  harness,
  HARBOR,
  KILN,
  lockedNow,
  openEntry,
} from './memoryScreen.tsx'

// The web's memory parity (e395d03, cb9caeb) on the shipped memory screen:
// how entries and kept drafts are named, and a refusal Discard clears.

/** A kept draft's key: the entry it was written for, `#2` when kept beside that entry's own. */
const key = (store: 'memory' | 'profile', content: string, beside = false) =>
  `${MEMORY_DRAFT_PREFIX}${store}:${fp(content)}${beside ? '#2' : ''}`

beforeEach(() => keptDrafts.clear())

describe('drafts under Unsaved drafts', () => {
  it('numbers the discard buttons of drafts that share a first line, and only those', async () => {
    keptDrafts.set(key('memory', 'A note Hermes no longer lists.'), 'Studio notes\nfirst')
    keptDrafts.set(key('memory', 'Another note gone.'), 'Studio notes\nsecond')
    keptDrafts.set(key('memory', 'A third note gone.'), 'Studio notes\nthird')
    keptDrafts.set(key('profile', 'Gone from the profile.'), 'Prefers tea')
    const h = harness()
    await h.settle()
    expect(h.buttons(/^Discard draft/).map((button) => button.name)).toEqual([
      'Discard draft 1 of 3: Studio notes',
      'Discard draft 2 of 3: Studio notes',
      'Discard draft 3 of 3: Studio notes',
      'Discard draft: Prefers tea',
    ])
    expect(
      h.hasText(
        "Text you wrote for entries Hermes no longer lists (removed, or changed elsewhere), and drafts kept beside an entry's own draft. Copy what you need; nothing here is saved.",
      ),
    ).toBe(true)
  })

  it('says which entry a draft kept beside its own was written for, while that entry is listed', async () => {
    keptDrafts.set(key('memory', KILN, true), 'A second take on the kiln log')
    const h = harness()
    await h.settle()
    expect(h.hasText('Written for agent note 2.')).toBe(true)
    // Once the entry is gone from the list, the draft says no more than its text.
    h.mem.set('memory', [GLAZE, HARBOR])
    h.remount()
    await h.settle()
    expect(h.hasText('A second take on the kiln log')).toBe(true)
    expect(h.hasText(/^Written for/)).toBe(false)
  })

  it('says so for a note about you as well (review 1b8252ea, S5)', async () => {
    keptDrafts.set(key('profile', BRIEF, true), 'A second take on the morning brief')
    const h = harness()
    await h.settle()
    expect(h.hasText('Written for note about you 1.')).toBe(true)
  })
})

describe('entry names', () => {
  it('names an entry with an empty title by its first line with words, else by its place', async () => {
    const h = harness([
      { store: 'memory', content: '#\nFirst words here, under a bare heading.' },
      { store: 'memory', content: '##\n###' },
      ...fixtureEntries,
    ])
    await h.settle()
    const opens = h.buttons(/^Open memory entry: /).map((button) => button.name)
    expect(opens.slice(0, 2)).toEqual([
      'Open memory entry: First words here, under a bare heading.',
      'Open memory entry: agent note 2',
    ])
  })

  it("names the entry now at a locked editor's place the same way (review 1b8252ea, S5)", async () => {
    const h = harness()
    await openEntry(h, /Glaze supplier/)
    // Elsewhere, another entry takes the place: its first line is a bare heading.
    h.mem.replace(/Glaze supplier/, '#\nThe glaze order moved to Fridays (fictional).')
    h.press('Reload')
    await h.settle()
    expect(lockedNow(h)).toBe(true)
    expect(
      h.hasText('Now at this place: “The glaze order moved to Fridays (fictional).”.'),
    ).toBe(true)
  })
})

describe('a refusal Discard clears', () => {
  // That the discard clears the refusal is pinned in editor-steps.test.tsx: the
  // refusal shows only in a review, and Edit clears it too, so this screen
  // cannot tell (review 1b8252ea, S4).
  it('refuses the same stale save again after a discard', async () => {
    const h = harness()
    await openEntry(h, /Glaze supplier/)
    h.press('Edit')
    h.change('Glaze supplier calls moved to Tuesdays (fictional supplier).')
    h.press('Review changes')
    // Elsewhere the entry changes after it was read.
    h.mem.replace(
      /Glaze supplier/,
      'Glaze supplier calls moved to Fridays (fictional supplier).',
    )
    h.press('Confirm and save')
    await h.settle()
    expect(h.alerts().join(' ')).toMatch(/changed since you read it/)
    h.back()
    await h.settle()
    h.back()
    await h.settle()
    h.press('Discard')
    await h.settle()
    // The text read is still the old one: saving it again is refused again.
    h.press('Edit')
    h.change('Glaze supplier calls moved to Mondays (fictional supplier).')
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.alerts().join(' ')).toMatch(/changed since you read it/)
    expect(h.mem.store('memory')[0]).toBe(
      'Glaze supplier calls moved to Fridays (fictional supplier).',
    )
  })
})

describe('focus after each step of the editor (web parity, cb9caeb)', () => {
  it('goes to what replaced the control pressed: the draft, the review, Edit', async () => {
    const h = harness()
    await openEntry(h, /Glaze supplier/)
    h.press('Edit')
    await h.settle()
    expect(h.focusLog().at(-1)).toBe('draft')
    expect(h.keyboardLog().at(-1)).toBe('draft')
    h.change('Glaze supplier calls moved to Tuesdays (fictional supplier).')
    h.press('Review changes')
    await h.settle()
    expect(h.focusLog().at(-1)).toMatch(
      /^Review before saving: 1 line added, 1 removed\./,
    )
    h.press('Back to editing')
    await h.settle()
    expect(h.focusLog().at(-1)).toBe('draft')
    h.press('Review changes')
    h.press('Confirm and save')
    await h.settle()
    expect(h.mem.store('memory')[0]).toBe(
      'Glaze supplier calls moved to Tuesdays (fictional supplier).',
    )
    expect(h.focusLog().at(-1)).toBe('button: Edit')
    expect(h.keyboardLog().at(-1)).toBe('button: Edit')
  })

  it('goes to Edit when the owner discards the changes in the box', async () => {
    keptDrafts.set(key('memory', GLAZE), 'Glaze supplier calls moved to Wednesdays.')
    const h = harness()
    // The kept draft is restored into the box as the entry opens.
    await openEntry(h, /Glaze supplier/)
    expect(h.field()?.value).toBe('Glaze supplier calls moved to Wednesdays.')
    h.press('Discard changes')
    await h.settle()
    expect(h.focusLog().at(-1)).toBe('button: Edit')
  })
  // The other steps, and a save that lands after another press: editor-steps.test.tsx.
})
