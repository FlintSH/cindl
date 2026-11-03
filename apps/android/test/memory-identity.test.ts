import { sha256Hex } from '@cindl/client-core'
import {
  CindlError,
  isCindlError,
  type MemoryEntry,
  type MemoryEntrySummary,
  type VersionedDocument,
} from '@cindl/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bindingLocked,
  deleteWarning,
  entryAt,
  followList,
  guardMemorySave,
  keepsVanishedRow,
  LOCKED_NOTICE,
  MEMORY_DRAFT_PREFIX,
  memoryDocument,
  memoryDraftKey,
  memoryWrite,
  orphanDrafts,
  placeOf,
  type Binding,
  type MemoryPlace,
} from '../src/library/memory.ts'
import {
  forgetDocumentDraft,
  forgetDrafts,
  keptDocumentDrafts,
  keptDrafts,
} from '../src/views/drafts.ts'
import {
  initialStage,
  lockedDraft,
  previousTextOffer,
  reviewMoved,
  reviewStage,
  type Stage,
} from '../src/views/editorModel.ts'
import {
  failedRead,
  replaceForKey,
  type ResourceState,
} from '../src/views/useResource.ts'

// The web reviewer's probes of entry identity (apps/web/test/memory-identity.test.tsx
// at 5606b13d), ported to Android. React Native components are not rendered in these
// Node tests, so the screen below drives the functions MemoryEntries.tsx,
// DocumentEditor.tsx and useResource.ts call, in the order they call them: a draft,
// a save and a delete stay bound to the entry the owner read, and text at a place
// that may be another entry locks the editor instead of being followed.
// SYNTHETIC data only; nothing here talks to Hermes.

afterEach(() => forgetDrafts())

type Store = 'memory' | 'profile'
const fixtureEntries: Array<{ store: Store; content: string }> = [
  {
    store: 'memory',
    content: 'Glaze supplier calls moved to Thursdays at 10:00 (fictional supplier).',
  },
  {
    store: 'memory',
    content: 'The kiln firing log lives in the studio inventory sheet, tab "Firings".',
  },
  {
    store: 'memory',
    content: 'Harbor Loft (fictional) holds the offsite date until Friday.',
  },
  { store: 'profile', content: 'Prefers a short morning brief, ready before 08:30.' },
  { store: 'profile', content: 'Protects focus time before 11:00 on weekdays.' },
]

const fp = (content: string) => sha256Hex(content.trim()).slice(0, 12)

/** Memory shaped like Hermes's learning routes, plus changes made elsewhere. */
function memoryBackend(initial: Array<{ store: Store; content: string }>) {
  const entries = initial.map((entry) => ({ ...entry }))
  const ordered = () => [
    ...entries.filter((e) => e.store === 'memory'),
    ...entries.filter((e) => e.store === 'profile'),
  ]
  const idOf = (e: { store: Store; content: string }) =>
    `memory:${e.store}:${ordered().indexOf(e)}:${fp(e.content)}`
  const find = (id: string) => {
    const [, store, , f] = id.split(':')
    const e = entries.find((c) => c.store === store && fp(c.content) === f)
    if (!e)
      throw new CindlError(
        'conflict',
        'This memory entry changed since you read it. Reload it and review again.',
      )
    return e
  }
  const byText = (re: RegExp) => {
    const e = entries.find((c) => re.test(c.content))
    if (!e) throw new Error(`no entry matching ${String(re)}`)
    return e
  }
  const now = '2026-11-03T09:00:00.000Z'
  return {
    list: (): MemoryEntrySummary[] =>
      ordered().map((e) => ({
        id: idOf(e),
        store: e.store,
        title: (e.content.split('\n')[0] ?? '').slice(0, 60),
        preview: e.content.slice(0, 1200),
        truncated: e.content.length > 1200,
      })),
    read: (id: string): MemoryEntry => {
      const e = find(id)
      return { id, store: e.store, content: e.content, readAt: now, source: 'probe' }
    },
    write: (id: string, content: string): MemoryEntry => {
      const e = find(id)
      e.content = content
      return { id: idOf(e), store: e.store, content, readAt: now, source: 'probe' }
    },
    delete: (id: string) => void entries.splice(entries.indexOf(find(id)), 1),
    add: (store: Store, content: string) => void entries.push({ store, content }),
    remove: (re: RegExp) => void entries.splice(entries.indexOf(byText(re)), 1),
    replace: (re: RegExp, content: string) => void (byText(re).content = content),
    has: (re: RegExp) => entries.some((e) => re.test(e.content)),
  }
}

/**
 * The Library's Memory screen: MemoryEntries (list, open place, vanished row,
 * unsaved drafts), EntryEditor (read, binding, save guard, delete) and
 * DocumentEditor (stage, kept drafts, backup), as the components wire them.
 */
function screen(initial = fixtureEntries) {
  const mem = memoryBackend(initial)
  const writes: string[] = []
  const deletes: string[] = []
  let holdList = false
  let failRead = false
  let release: (() => void) | undefined
  const pending: Array<Promise<unknown>> = []

  let list: MemoryEntrySummary[] | undefined
  let open: MemoryPlace | undefined

  interface Editor {
    place: number
    resource: ResourceState<MemoryEntry> | undefined
    binding: Binding
    listed: string | undefined
    stage: Stage | undefined
    backup: { content: string; version: string } | undefined
    failure: { message: string; conflict: boolean } | undefined
  }
  let editor: Editor | undefined

  const summary = () => (open && list ? entryAt(list, open) : undefined)
  const data = () => editor?.resource?.data
  const locked = () => Boolean(editor) && bindingLocked(editor!.binding, data()?.id)
  const document = (): VersionedDocument | undefined => {
    const entry = data()
    return entry && editor ? memoryDocument(entry, editor.place) : undefined
  }
  const draftKey = () => {
    const entry = data()
    return entry ? memoryDraftKey(entry.id) : undefined
  }

  // DocumentEditor mounts once the entry is read, on the draft kept for it, and keeps
  // a locked draft under its key (its effect, run after every change).
  const render = () => {
    // MemoryEntries renders the open editor in its entry's row, or in the row kept for
    // an entry that vanished; without either, the editor (and its draft) is gone.
    if (editor && !summary() && !keepsVanishedRow(open, summary(), Boolean(list))) {
      editor = undefined
      open = undefined
    }
    if (!editor) return
    const key = draftKey()
    if (key && !editor.stage) editor.stage = initialStage(keptDrafts.get(key))
    // EntryEditor: once per change of the entry listed at its place.
    const listedNow = summary()?.id
    if (editor.listed !== listedNow) {
      editor.listed = listedNow
      const next = followList(
        editor.binding,
        data()?.id,
        listedNow,
        Boolean(editor.resource?.error),
      )
      editor.binding = next.binding
      if (next.reread) read()
    }
    const keep = lockedDraft(
      locked() ? LOCKED_NOTICE : undefined,
      editor.stage ?? { kind: 'view' },
    )
    if (key && keep !== undefined) keptDrafts.set(key, keep)
  }

  /** useResource for the open place: keyed by place, keeping data when a re-read fails. */
  const read = () => {
    const current = editor
    if (!current) return
    const target = summary()
    const key = `memory:${open?.store}:${current.place}`
    const token = (current.resource?.token ?? 0) + 1
    const run = async () => {
      // The read answers later, like the real one (useResource sets state in a callback).
      await Promise.resolve()
      try {
        if (!target)
          throw new CindlError('not-found', 'This entry was removed in Hermes.')
        if (failRead) {
          failRead = false
          throw new CindlError('unavailable', 'Hermes is not answering.')
        }
        const entry = mem.read(target.id)
        if (editor === current) current.resource = { key, token, data: entry }
      } catch (error) {
        if (editor === current)
          current.resource = failedRead(current.resource, {
            key,
            token,
            error: isCindlError(error) ? error.message : 'failed',
          })
      }
      render()
    }
    pending.push(run())
  }

  const loadList = () => {
    const run = async () => {
      if (holdList) {
        holdList = false
        await new Promise<void>((resolve) => (release = resolve))
      }
      list = mem.list()
      render()
    }
    pending.push(run())
  }

  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0))
  }

  const ui = {
    mem,
    writes,
    deletes,
    holdNextList: () => (holdList = true),
    failNextRead: () => (failRead = true),
    release: () => release?.(),
    settle,
    /** Leave the screen and come back: the editor is gone, the list is read again. */
    remount: async () => {
      editor = undefined
      open = undefined
      loadList()
      await settle()
    },
    open: async (title: RegExp) => {
      await settle()
      const entry = list?.find((e) => title.test(e.title))
      if (!entry) throw new Error(`no row for ${String(title)}`)
      open = placeOf(list ?? [], entry.id)
      const place = (open?.index ?? 0) + 1
      editor = {
        place,
        resource: undefined,
        binding: 'following',
        listed: entry.id,
        stage: undefined,
        backup: undefined,
        failure: undefined,
      }
      read()
      await settle()
    },
    close: () => {
      editor = undefined
      open = undefined
    },
    /** The row's title as the list shows it at the open place, or the vanished row. */
    openRowTitle: () => summary()?.title ?? (open ? 'Removed in Hermes' : undefined),
    /** DocumentEditor's buttons and fields, as the owner sees them. */
    edit: (text: string) => {
      if (!editor || editor.stage?.kind !== 'view' || locked()) throw new Error('no Edit')
      editor.failure = undefined
      editor.stage = { kind: 'edit', draft: text }
      render()
    },
    field: () => {
      const stage = editor?.stage
      const doc = document()
      return stage?.kind === 'edit' && doc
        ? { label: `Edit ${doc.key}`, value: stage.draft, readOnly: locked() }
        : undefined
    },
    alerts: () => {
      const out: string[] = []
      const stage = editor?.stage
      const doc = document()
      if (locked()) out.push(LOCKED_NOTICE)
      if (stage?.kind === 'review' && doc && reviewMoved(stage.base, doc) && !locked())
        out.push('This text changed in Hermes while you were reviewing')
      if (editor?.failure) out.push(editor.failure.message)
      if (editor?.resource?.error && !locked()) out.push(editor.resource.error)
      return out
    },
    keptNotice: () => {
      const key = draftKey()
      return Boolean(
        key && keptDrafts.has(key) && editor?.stage?.kind !== 'view' && !locked(),
      )
    },
    reviewEnabled: () => {
      const stage = editor?.stage
      const doc = document()
      return Boolean(
        stage?.kind === 'edit' && doc && !locked() && stage.draft !== doc.content,
      )
    },
    review: () => {
      const stage = editor?.stage
      const doc = document()
      if (!editor || stage?.kind !== 'edit' || !doc || !ui.reviewEnabled())
        throw new Error('Review changes is disabled')
      editor.stage = reviewStage(stage.draft, doc)
      render()
    },
    reviewedAgainst: () => document()?.content,
    confirmEnabled: () => {
      const stage = editor?.stage
      const doc = document()
      return Boolean(
        stage?.kind === 'review' &&
        doc &&
        !reviewMoved(stage.base, doc) &&
        !locked() &&
        !editor?.failure?.conflict,
      )
    },
    /** "Confirm and save": EntryEditor's onSave inside DocumentEditor's save. */
    confirm: async () => {
      const current = editor
      const stage = current?.stage
      const entry = data()
      const key = draftKey()
      const doc = document()
      if (!current || stage?.kind !== 'review' || !entry || !key || !doc)
        throw new Error('nothing to confirm')
      if (!ui.confirmEnabled()) throw new Error('Confirm and save is disabled')
      try {
        guardMemorySave(locked(), doc.version, stage.base)
        const args = memoryWrite(entry, stage.draft)
        writes.push(args.id)
        const saved = mem.write(args.id, args.content)
        // useResource.replace, for its own key only.
        current.resource = replaceForKey(current.resource, {
          key: current.resource?.key ?? '',
          token: current.resource?.token ?? 0,
          data: saved,
        })
        loadList()
        keptDrafts.delete(key)
        current.backup = {
          content: doc.content,
          version: memoryDocument(saved, current.place).version,
        }
        current.stage = { kind: 'view' }
      } catch (error) {
        if (isCindlError(error) && error.code === 'conflict') {
          keptDrafts.set(key, stage.draft)
          current.failure = {
            message: `${error.message} Your draft is kept.`,
            conflict: true,
          }
        } else throw error
      }
      render()
      await settle()
    },
    /** "Reload and keep my draft": the list names the entry's current id; the read follows it. */
    reloadAndKeep: async () => {
      const stage = editor?.stage
      if (!editor || stage?.kind !== 'review' || !editor.failure?.conflict)
        throw new Error('no Reload and keep my draft')
      loadList()
      editor.failure = undefined
      editor.stage = { kind: 'edit', draft: stage.draft }
      render()
      await settle()
    },
    /** DocumentEditor's view-stage "Reload": the list only. */
    reload: () => loadList(),
    previousText: () => {
      const doc = document()
      const offer =
        doc &&
        previousTextOffer(editor?.backup, doc, locked() ? LOCKED_NOTICE : undefined)
      return offer ? { offer, content: editor?.backup?.content } : undefined
    },
    deleteOffered: () => Boolean(editor && data() && !locked()),
    /** "Delete entry…": the confirmation names the entry; the delete names the id read. */
    deleteConfirmation: () => {
      const entry = data()
      if (!entry || locked()) throw new Error('no Delete entry…')
      return deleteWarning(summary()?.title ?? entry.content.split('\n')[0] ?? '')
    },
    deletePermanently: async () => {
      const entry = data()
      if (!entry || locked()) throw new Error('no Delete entry…')
      deletes.push(entry.id)
      mem.delete(entry.id)
      ui.close()
      loadList()
      await settle()
    },
    adopt: async () => {
      const current = editor
      const target = summary()
      const key = draftKey()
      if (!current || !target || !key || !locked() || typeof current.binding === 'object')
        throw new Error('no "Use this draft for the entry now here"')
      forgetDocumentDraft(key)
      current.binding = { adopting: target.id }
      read()
      await settle()
    },
    /** MemoryEntries: drafts for entries Hermes no longer lists, while no entry is open. */
    unsavedDrafts: () =>
      open || !list ? [] : orphanDrafts(list, keptDocumentDrafts(MEMORY_DRAFT_PREFIX)),
    discardDraft: (key: string) => forgetDocumentDraft(key),
    shownText: () => document()?.content,
  }
  loadList()
  return ui
}

const draft = 'The kiln firing log moved to the studio binder (fictional).'
const harborFp = fp('Harbor Loft (fictional) holds the offsite date until Friday.')

/** What the owner sees, and what one more Review + Confirm would send. */
async function tryToSave(s: ReturnType<typeof screen>) {
  const seen = {
    alert: s.alerts().join(' '),
    keptNotice: s.keptNotice(),
    field: s.field(),
    reviewEnabled: s.reviewEnabled(),
  }
  if (seen.reviewEnabled) {
    s.review()
    if (s.confirmEnabled()) await s.confirm()
  }
  return seen
}

/** Open the kiln note, edit it, review, and see the save refused because it was removed. */
async function conflictAfterRemoval(s: ReturnType<typeof screen>) {
  await s.open(/The kiln firing log/)
  s.edit(draft)
  s.review()
  s.mem.remove(/kiln firing log/)
  await s.confirm()
  expect(s.alerts().join(' ')).toMatch(/changed since you read it/)
}

describe('a kept draft and the editor stay bound to the entry that was read', () => {
  it('N1: after the lock, closing and reopening the place does not offer the kept draft over the entry now there', async () => {
    const s = screen()
    await conflictAfterRemoval(s)
    await s.reloadAndKeep()
    expect(s.alerts().join(' ')).toMatch(/removed or moved in Hermes/)
    expect(s.openRowTitle()).toMatch(/^Harbor Loft/)
    s.close()
    await s.open(/Harbor Loft/)
    const seen = await tryToSave(s)
    expect(seen.keptNotice).toBe(false)
    expect(seen.field).toBeUndefined()
    // The only write is the refused first attempt, to the kiln note's own id.
    expect(s.writes).toHaveLength(1)
    expect(s.writes.some((id) => id.endsWith(`:${harborFp}`))).toBe(false)
    expect(s.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('N1b: a draft kept after a conflict is not offered over the entry that later holds its place (close, leave, come back)', async () => {
    const s = screen()
    await conflictAfterRemoval(s)
    expect(s.openRowTitle()).toMatch(/^The kiln firing log/)
    s.close()
    await s.remount()
    await s.open(/Harbor Loft/)
    const seen = await tryToSave(s)
    expect(seen.keptNotice).toBe(false)
    expect(s.writes).toHaveLength(1)
    expect(s.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('N1d: nothing is deleted from the locked editor, and the reopened place shows its own entry', async () => {
    const s = screen()
    await conflictAfterRemoval(s)
    await s.reloadAndKeep()
    // Locked: no delete is offered for the entry now at the place.
    expect(s.deleteOffered()).toBe(false)
    s.close()
    // Closed, the kiln draft is listed to copy, not attached to Harbor Loft.
    expect(s.unsavedDrafts().map((d) => d.draft)).toEqual([draft])
    await s.open(/Harbor Loft/)
    expect(s.field()).toBeUndefined()
    expect(s.shownText()).toMatch(/^Harbor Loft \(fictional\) holds the offsite date/)
    expect(s.deleteConfirmation()).toMatch(/^Delete “Harbor Loft/)
    expect(s.deletes).toHaveLength(0)
    expect(s.mem.has(/Harbor Loft/)).toBe(true)
  })
})

describe('text at the place that may be another entry locks the editor', () => {
  const merge = (s: ReturnType<typeof screen>) => {
    // Elsewhere, the agent merges the kiln note into the Harbor note.
    s.mem.remove(/kiln firing log/)
    s.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
  }

  it('N2: an entry removed while the next one is rewritten (a merge) locks instead of following the neighbour', async () => {
    const s = screen()
    await s.open(/The kiln firing log/)
    s.holdNextList()
    s.reload()
    s.edit(draft)
    merge(s)
    s.release()
    await s.settle()
    const seen = await tryToSave(s)
    expect(seen.alert).toMatch(/removed or moved in Hermes/)
    expect(seen.field).toEqual({
      label: 'Edit agent note 2',
      value: draft,
      readOnly: true,
    })
    expect(s.writes).toHaveLength(0)
    expect(s.mem.has(/until Monday/)).toBe(true)
  })

  it('N2c: the same merge during review, then "Reload and keep my draft"', async () => {
    const s = screen()
    await s.open(/The kiln firing log/)
    s.edit(draft)
    s.review()
    merge(s)
    await s.confirm()
    await s.reloadAndKeep()
    const seen = await tryToSave(s)
    expect(seen.keptNotice || seen.reviewEnabled).toBe(false)
    expect(s.writes).toHaveLength(1)
    expect(s.mem.has(/until Monday/)).toBe(true)
  })

  it('N2d: after the merge, no delete is offered from the kiln draft, so the rewritten neighbour stays', async () => {
    const s = screen()
    await s.open(/The kiln firing log/)
    s.holdNextList()
    s.reload()
    s.edit(draft)
    merge(s)
    s.release()
    await s.settle()
    expect(s.deleteOffered()).toBe(false)
    expect(s.deletes).toHaveLength(0)
    expect(s.mem.has(/until Monday/)).toBe(true)
  })

  it('N3: the last entry removed and a new one added in its place does not receive the old draft', async () => {
    const s = screen()
    await s.open(/Harbor Loft/)
    s.holdNextList()
    s.reload()
    s.edit('Harbor Loft (fictional) holds the offsite date until Tuesday.')
    s.mem.remove(/Harbor Loft/)
    s.mem.add('memory', 'Bisque firings moved to the small kiln (fictional).')
    s.release()
    await s.settle()
    const seen = await tryToSave(s)
    expect(seen.alert.length).toBeGreaterThan(0)
    expect(s.writes).toHaveLength(0)
    expect(s.mem.has(/Bisque firings/)).toBe(true)
  })

  it('follows the same text under a new number (an earlier entry was removed), even when its read fails', async () => {
    const s = screen()
    await s.open(/Prefers a short morning brief/)
    s.holdNextList()
    s.reload()
    s.edit('Prefers a short morning brief, ready before 08:15.')
    s.mem.remove(/Glaze supplier/)
    s.failNextRead()
    s.release()
    await s.settle()
    expect(s.field()?.value).toBe('Prefers a short morning brief, ready before 08:15.')
    expect(s.alerts()).toEqual(['Hermes is not answering.'])
    s.reload()
    await s.settle()
    s.review()
    await s.confirm()
    expect(s.mem.has(/08:15/)).toBe(true)
    expect(s.mem.has(/Harbor Loft/) && s.mem.has(/kiln firing log/)).toBe(true)
  })
})

describe('an entry that vanishes keeps its row and draft', () => {
  it('N4: the only entry of a store removed during editing keeps its row and draft', async () => {
    const s = screen(fixtureEntries.filter((e) => !/morning brief/.test(e.content)))
    await s.open(/Protects focus time/)
    s.holdNextList()
    s.reload()
    s.edit('My unsaved note (fictional).')
    s.mem.remove(/Protects focus time/)
    s.release()
    await s.settle()
    expect(s.openRowTitle()).toBe('Removed in Hermes')
    expect(s.field()).toEqual({
      label: 'Edit note about you 1',
      value: 'My unsaved note (fictional).',
      readOnly: true,
    })
  })

  it('N4b: the last entry in Hermes removed during editing keeps its row and draft', async () => {
    const s = screen([{ store: 'memory', content: 'Only note (fictional).' }])
    await s.open(/Only note/)
    s.holdNextList()
    s.reload()
    s.edit('Only note, edited (fictional).')
    s.mem.remove(/Only note/)
    s.release()
    await s.settle()
    expect(s.openRowTitle()).toBe('Removed in Hermes')
    expect(s.field()?.value).toBe('Only note, edited (fictional).')
  })
})

describe('restore after a save', () => {
  it('N9: when another entry takes the place right after a save, the previous text is still on screen', async () => {
    const s = screen()
    await s.open(/The kiln firing log/)
    s.edit(draft)
    s.review()
    s.holdNextList()
    await Promise.race([s.confirm(), Promise.resolve()])
    s.mem.remove(/Glaze supplier/)
    s.release()
    await s.settle()
    expect(s.alerts().join(' ')).toMatch(/removed or moved in Hermes/)
    // Restoring would write over another entry: the replaced text is only shown.
    expect(s.previousText()).toEqual({
      offer: 'copy',
      content: 'The kiln firing log lives in the studio inventory sheet, tab "Firings".',
    })
  })

  it('offers the replaced text for restore only onto the version the save produced', async () => {
    const s = screen()
    await s.open(/The kiln firing log/)
    s.edit(draft)
    s.review()
    await s.confirm()
    expect(s.previousText()?.offer).toBe('restore')
  })
})

describe('explicit re-selection', () => {
  it('uses a locked draft for the entry now here only when the owner chooses it', async () => {
    const s = screen()
    await s.open(/The kiln firing log/)
    s.holdNextList()
    s.reload()
    s.edit(draft)
    s.mem.remove(/kiln firing log/)
    s.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    s.release()
    await s.settle()
    expect(s.reviewEnabled()).toBe(false)
    await s.adopt()
    // Now the review compares the draft with the rewritten entry, in full view.
    s.review()
    expect(s.reviewedAgainst()).toContain('until Monday')
    await s.confirm()
    expect(s.writes).toHaveLength(1)
    expect(s.mem.has(/studio binder/)).toBe(true)
    expect(s.mem.has(/until Monday/)).toBe(false)
  })

  it('discards a kept draft from the list only when asked', async () => {
    const s = screen()
    await s.open(/The kiln firing log/)
    s.holdNextList()
    s.reload()
    s.edit(draft)
    s.mem.remove(/kiln firing log/)
    s.release()
    await s.settle()
    s.close()
    expect(s.unsavedDrafts().map((d) => d.draft)).toEqual([draft])
    await s.remount()
    const [kept] = s.unsavedDrafts()
    expect(kept?.draft).toBe(draft)
    s.discardDraft(kept?.key ?? '')
    expect(s.unsavedDrafts()).toEqual([])
    expect(s.writes).toHaveLength(0)
  })
})

describe('the rules the screen is built on', () => {
  it('names an entry by its store and text, not by its number', () => {
    const before = memoryDraftKey(`memory:memory:2:${harborFp}`)
    expect(memoryDraftKey(`memory:memory:1:${harborFp}`)).toBe(before)
    expect(memoryDraftKey(`memory:profile:1:${harborFp}`)).not.toBe(before)
  })

  it('locks on any other text at the place, and stays locked until the adopted entry is read', () => {
    const kiln = 'memory:memory:1:aaaaaaaaaaaa'
    const harbor = `memory:memory:1:${harborFp}`
    expect(followList('following', kiln, 'memory:memory:0:aaaaaaaaaaaa', false)).toEqual({
      binding: 'following',
      reread: true,
    })
    expect(followList('following', kiln, harbor, false).binding).toBe('locked')
    expect(followList('following', kiln, undefined, false).binding).toBe('locked')
    expect(followList('locked', kiln, kiln, false).binding).toBe('locked')
    expect(bindingLocked({ adopting: harbor }, kiln)).toBe(true)
    expect(bindingLocked({ adopting: harbor }, harbor)).toBe(false)
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
