// Re-check de42f21: the reviewer's probes of drafts around an adoption, a
// refused adoption, what a delete names, and focus, kept as regressions with
// their assertions unchanged. Synthetic data only.
import { sha256Hex } from '@cindl/client-core'
import { CindlProvider } from '@cindl/client-react'
import { CindlError, type CindlClientApi, type CindlEvent } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryView } from '../src/library/LibraryView.tsx'
import { AppShell } from '../src/shell/AppShell.tsx'
import { forgetDocumentDrafts, keptDocumentDrafts } from '../src/views/DocumentEditor.tsx'

afterEach(() => {
  cleanup()
  forgetDocumentDrafts()
  window.history.replaceState(null, '', '#/')
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })

type Store = 'memory' | 'profile'
type Entry = { store: Store; content: string }
const GLAZE = 'Glaze supplier calls moved to Thursdays at 10:00 (fictional supplier).'
const KILN = 'The kiln firing log lives in the studio inventory sheet, tab "Firings".'
const HARBOR = 'Harbor Loft (fictional) holds the offsite date until Friday.'
const HARBOR_MON = 'Harbor Loft (fictional) holds the offsite date until Monday.'
const BRIEF = 'Prefers a short morning brief, ready before 08:30.'
const FOCUS = 'Protects focus time before 11:00 on weekdays.'
const fixtureEntries: Entry[] = [
  { store: 'memory', content: GLAZE },
  { store: 'memory', content: KILN },
  { store: 'memory', content: HARBOR },
  { store: 'profile', content: BRIEF },
  { store: 'profile', content: FOCUS },
]
const fp = (content: string) => sha256Hex(content.trim()).slice(0, 12)
/** The confirmation's naming rule, copied from MemoryEntries.tsx `titleOf`. */
const titleOf = (content: string) => {
  const first = (content.trim().split('\n')[0] ?? '').replace(/^[#\s]+/, '').trim()
  return first.length > 80 ? `${first.slice(0, 80)}…` : first
}

/** Memory shaped like Hermes: ids resolve by store and fingerprint, first match (fake-hermes `locate`). */
function memoryBackend(initial: Entry[]) {
  const entries = initial.map((entry) => ({ ...entry }))
  const ordered = () => [
    ...entries.filter((e) => e.store === 'memory'),
    ...entries.filter((e) => e.store === 'profile'),
  ]
  const idOf = (e: Entry) => `memory:${e.store}:${ordered().indexOf(e)}:${fp(e.content)}`
  const resolve = (id: string) => {
    const [, store, , f] = id.split(':')
    return entries.find((c) => c.store === store && fp(c.content) === f)
  }
  const find = (id: string) => {
    const e = resolve(id)
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
  const now = () => new Date(Date.UTC(2026, 10, 3, 9, 0)).toISOString()
  const ops: Record<string, (args: never) => unknown> = {
    'memory.entries': () =>
      ordered().map((e) => ({
        id: idOf(e),
        store: e.store,
        title: (e.content.split('\n')[0] ?? '').slice(0, 60),
        preview: e.content.slice(0, 1200),
        truncated: e.content.length > 1200,
      })),
    'memory.read': ({ id }: { id: string }) => {
      const e = find(id)
      return { id, store: e.store, content: e.content, readAt: now(), source: 'probe' }
    },
    // Like the adapter: the same index as the id written, with the new fingerprint.
    'memory.write': ({ id, content }: { id: string; content: string }) => {
      const e = find(id)
      e.content = content.trim()
      const [, store, index] = id.split(':')
      return {
        id: `memory:${store}:${index}:${fp(e.content)}`,
        store: e.store,
        content: e.content,
        readAt: now(),
        source: 'probe',
      }
    },
    'memory.delete': ({ id }: { id: string }) => {
      entries.splice(entries.indexOf(find(id)), 1)
      return { deleted: true }
    },
  }
  return {
    ops,
    resolve,
    add: (store: Store, content: string) => void entries.push({ store, content }),
    remove: (re: RegExp) => void entries.splice(entries.indexOf(byText(re)), 1),
    replace: (re: RegExp, content: string) => void (byText(re).content = content),
    has: (re: RegExp) => entries.some((e) => re.test(e.content)),
    contents: () => ordered().map((e) => `${e.store}: ${e.content.slice(0, 40)}`),
  }
}

type Gate = 'memory.entries' | 'memory.read' | 'memory.write'
/**
 * `hold(gate)` delays a call before Hermes sees it; `holdAnswer(gate)` lets
 * Hermes answer at once and delays the answer (a slow response).
 */
function harness(initial = fixtureEntries) {
  const scenario = createScenarioClient({ speed: 0 })
  const mem = memoryBackend(initial)
  const calls: Array<{ name: string; args: unknown }> = []
  const held = new Map<Gate, 'request' | 'answer'>()
  const releases = new Map<Gate, () => void>()
  const failNext = new Map<string, CindlError>()
  const state = { refuseDeletes: false }
  const api: CindlClientApi = {
    call: (async (name: string, args: unknown) => {
      calls.push({ name, args })
      const mode = held.get(name as Gate)
      if (mode) held.delete(name as Gate)
      const gate = () =>
        new Promise<void>((resolve) => releases.set(name as Gate, resolve))
      if (mode === 'request') await gate()
      const failure = failNext.get(name)
      if (failure) {
        failNext.delete(name)
        if (mode === 'answer') await gate()
        throw failure
      }
      if (name === 'memory.delete' && state.refuseDeletes)
        throw new CindlError('unavailable', 'Probe refused the delete.')
      const op = mem.ops[name]
      let result: unknown
      let error: unknown
      try {
        result = op
          ? op(args as never)
          : await scenario.call(name as never, args as never)
      } catch (err) {
        error = err
      }
      if (mode === 'answer') await gate()
      if (error instanceof Error) throw error
      return result
    }) as CindlClientApi['call'],
    subscribe: (listener) => scenario.subscribe(listener),
  }
  const view = render(
    <CindlProvider api={api}>
      <LibraryView section="memory" />
    </CindlProvider>,
  )
  return {
    api,
    mem,
    calls,
    state,
    view,
    writes: () =>
      calls
        .filter((c) => c.name === 'memory.write')
        .map((c) => c.args as { id: string; content: string }),
    deletes: () =>
      calls
        .filter((c) => c.name === 'memory.delete')
        .map((c) => c.args as { id: string }),
    reads: () =>
      calls
        .filter((c) => c.name === 'memory.read')
        .map((c) => (c.args as { id: string }).id),
    hold: (gate: Gate) => void held.set(gate, 'request'),
    holdAnswer: (gate: Gate) => void held.set(gate, 'answer'),
    release: (gate: Gate) => {
      const resolve = releases.get(gate)
      releases.delete(gate)
      resolve?.()
    },
    failNext: (name: string, error: CindlError) => void failNext.set(name, error),
  }
}
type H = ReturnType<typeof harness>

const open = async (title: RegExp) => {
  await settle()
  fireEvent.click(
    await screen.findByRole('button', {
      name: new RegExp(`Open memory entry: ${title.source}`),
    }),
  )
  await settle()
}
const button = (name: string | RegExp) =>
  screen.queryByRole<HTMLButtonElement>('button', { name })
const editTo = (label: string, text: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } })
}
const holdListAndReload = async (h: H) => {
  h.hold('memory.entries')
  fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
  await settle()
}
const releaseList = async (h: H) => {
  h.release('memory.entries')
  await settle()
  await settle()
}
const alerts = () => screen.queryAllByRole('alert').map((a) => a.textContent ?? '')
const lockedNow = () => alerts().some((a) => /cannot tell which/.test(a))
const textarea = () =>
  screen.queryByLabelText<HTMLTextAreaElement>(/^Edit (agent note|note about you) \d$/)
const keptMemoryDrafts = () => keptDocumentDrafts('memory-draft:').map((d) => d.draft)
const keptKeys = () => keptDocumentDrafts('memory-draft:').map((d) => d.key)
const focusName = () => {
  const el = document.activeElement
  if (!el || el === document.body) return 'BODY'
  return `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 40) ?? ''}`
}

const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'
const D_H = 'Harbor draft: the offsite date moved to Monday (fictional).'

async function lockedByMerge(h: H) {
  await open(/The kiln firing log/)
  await holdListAndReload(h)
  editTo('Edit agent note 2', D_K)
  h.mem.remove(/kiln firing log/)
  h.mem.replace(/Harbor Loft/, HARBOR_MON)
  await releaseList(h)
  expect(lockedNow()).toBe(true)
}

/**
 * Opens the delete confirmation, sends the delete (refused by the probe so
 * nothing changes), and reports what was named against what the sent id
 * resolves to in Hermes now.
 */
async function deleteCheck(h: H) {
  const del = button('Delete entry…')
  if (!del) return { offered: false as const }
  fireEvent.click(del)
  const text =
    screen.getByRole('group', { name: 'Delete this memory entry' }).textContent ?? ''
  const named = /Delete “(.*)” from Hermes/.exec(text)?.[1] ?? null
  const before = h.deletes().length
  h.state.refuseDeletes = true
  fireEvent.click(button('Delete permanently')!)
  await settle()
  h.state.refuseDeletes = false
  const sent = h.deletes()[before]?.id ?? null
  if (button('Keep it')) fireEvent.click(button('Keep it')!)
  await settle()
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
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    // 1. A Harbor draft is kept: Glaze removed, so Extra takes Harbor's place 3.
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(keptMemoryDrafts()).toContain(D_H)
    // 2. A kiln draft is kept: kiln (now place 1) removed, so Harbor takes place 1.
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    // 3. The owner uses the kiln draft for Harbor.
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const promised = Boolean(
      screen.queryByText(
        /This entry also has an unsaved draft of its own, which stays kept/,
      ),
    )
    // 4. Changes their mind: discards the kiln draft, then edits Harbor afresh and saves.
    fireEvent.click(button('Discard changes')!)
    await settle()
    const afterDiscard = {
      kept: keptMemoryDrafts(),
      harborDraftOnScreen: document.body.textContent?.includes(D_H),
    }
    editTo(
      'Edit agent note 1',
      'Harbor Loft (fictional) holds the offsite date until Tuesday.',
    )
    const editing = {
      box: textarea()?.value,
      harborDraftOnScreen: document.body.textContent?.includes(D_H),
    }
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    const saved = { kept: keptMemoryDrafts(), writes: h.writes().map((w) => w.content) }
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const closed = {
      unsaved: Boolean(screen.queryByText('Unsaved drafts')),
      harborDraftOnScreen: document.body.textContent?.includes(D_H) ?? false,
    }
    expect(promised).toBe(true)
    // Harbor's own draft is shown, kept, while the box edits afresh, and it outlives the save.
    expect(afterDiscard.kept).toEqual([D_H])
    expect(afterDiscard.harborDraftOnScreen).toBe(true)
    expect(editing.box).toBe(
      'Harbor Loft (fictional) holds the offsite date until Tuesday.',
    )
    expect(saved.kept).toContain(D_H)
    expect(saved.writes).toEqual([
      'Harbor Loft (fictional) holds the offsite date until Tuesday.',
    ])
    expect(closed.unsaved).toBe(true)
    expect(closed.harborDraftOnScreen).toBe(true)
  })

  it("X1c (control): the same adoption and discard, then close and reopen: the entry's own draft comes back", async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    fireEvent.click(button('Discard changes')!)
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    await open(/Harbor Loft/)
    expect(textarea()?.value).toBe(D_H)
  })

  it('X2: an adoption refused because the entry now here changed again can be completed from the editor (retry or a reload control)', async () => {
    const h = harness()
    await lockedByMerge(h)
    // Elsewhere, the agent edits the entry now here once more; the list has not reloaded.
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Wednesday.',
    )
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const first = {
      alerts: alerts().map((a) => a.slice(0, 90)),
      kept: keptMemoryDrafts(),
      controls: screen.queryAllByRole('button').map((b) => b.textContent),
    }
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const second = {
      locked: lockedNow(),
      alerts: alerts().map((a) => a.slice(0, 90)),
      reads: h.reads().map((id) => id.split(':').slice(2).join(':')),
    }
    expect(first.kept).toContain(D_K)
    const reloadOffered = first.controls.some((c) => /Reload/.test(c ?? ''))
    expect(second.locked === false || reloadOffered).toBe(true)
  })

  it("X7: discarding while the adoption read is out does not file the entry's own text as a draft for the old entry", async () => {
    const h = harness()
    await lockedByMerge(h)
    h.hold('memory.read')
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    fireEvent.click(button('Discard changes')!)
    await settle()
    h.release('memory.read')
    await settle()
    await settle()
    const s1 = {
      locked: lockedNow(),
      kept: keptMemoryDrafts(),
      edit: Boolean(button('Edit')),
    }
    if (s1.edit) fireEvent.click(button('Edit')!)
    await settle()
    const s2 = {
      note:
        screen
          .queryByText(/This draft was written for the entry that was here before/)
          ?.textContent?.slice(0, 60) ?? null,
      box: textarea()?.value ?? null,
      kept: keptKeys(),
    }
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const s3 = {
      unsaved: Boolean(screen.queryByText('Unsaved drafts')),
      kept: keptMemoryDrafts(),
    }
    expect(s2.note).toBeNull()
    expect(s3.kept).toEqual([])
  })

  it('X1b: after an adoption is discarded, Edit shows the entry text under "Your unsaved draft was kept", and the save then forgets that draft', async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    fireEvent.click(button('Discard changes')!)
    await settle()
    fireEvent.click(button('Edit')!)
    await settle()
    const seen = {
      keptNote: Boolean(
        screen.queryByText(/Your unsaved draft was kept after the conflict/),
      ),
      box: textarea()?.value ?? null,
      kept: keptMemoryDrafts(),
    }
    // If the note says a draft was kept, the box holds it.
    expect(seen.keptNote ? seen.box === D_H : true).toBe(true)
    // The same rule with today's wording, which no longer says "after the conflict".
    const keptNoteNow = Boolean(screen.queryByText(/^Your unsaved draft was kept\./))
    expect(keptNoteNow ? seen.box === D_H : true).toBe(true)
    expect(seen.kept).toEqual([D_H])
  })

  it('R6: an adoption refused because the entry here changed fetches the list, so trying again uses the entry now here', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Wednesday.',
    )
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(alerts().join(' ')).toMatch(/changed since you read it/)
    expect(keptMemoryDrafts()).toContain(D_K)
    // A reload is offered in the locked editor, and the list was already fetched.
    expect(screen.queryAllByRole('button', { name: 'Reload' }).length).toBeGreaterThan(0)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    expect(textarea()!.value).toBe(D_K)
    fireEvent.click(button('Review changes')!)
    expect(screen.getByLabelText('Changes').textContent).toContain('until Wednesday')
    expect(h.writes()).toEqual([])
  })

  it('R7: an adopted draft beside an entry that moved up says it stays under Unsaved drafts, and it does', async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note about the studio van (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    // Elsewhere Glaze is removed: the adopted Harbor note moves up a place.
    h.mem.remove(/Glaze supplier/)
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    const said = alerts().join(' ')
    expect(said).toMatch(
      /The same text is now agent note 1\. This draft was written for another entry, so when you close this it stays under Unsaved drafts/,
    )
    expect(said).not.toMatch(/open it there/)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(screen.getByText('Unsaved drafts')).toBeTruthy()
    expect(document.body.textContent).toContain(D_K)
  })

  it('R8: a fresh edit that hits a conflict while the entry has its own kept draft is kept beside it, not over it', async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    // Harbor's own draft is kept (Glaze removed under its editor).
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    // A kiln draft is used for Harbor, then discarded: Harbor's own draft is offered.
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(
      screen.getByText('An unsaved draft for this is kept on this device:'),
    ).toBeTruthy()
    // The owner starts afresh instead; the save is refused (Harbor changed elsewhere).
    const FRESH = 'Harbor fresh draft: the offsite moves to Thursday (fictional).'
    editTo('Edit agent note 1', FRESH)
    expect(
      screen.getByText(/Another unsaved draft for this is kept on this device/),
    ).toBeTruthy()
    fireEvent.click(button('Review changes')!)
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(keptMemoryDrafts()).toEqual(expect.arrayContaining([D_H, FRESH]))
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(screen.getByText('Unsaved drafts')).toBeTruthy()
    expect(document.body.textContent).toContain(D_H)
    expect(document.body.textContent).toContain(FRESH)
    expect(h.deletes()).toEqual([])
  })

  it("R9: discarding a fresh edit leaves the entry's own kept draft, which is offered again", async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    fireEvent.click(button('Discard changes')!)
    await settle()
    editTo('Edit agent note 1', 'Harbor afterthought (fictional).')
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(keptMemoryDrafts()).toEqual([D_H])
    expect(
      screen.getByText('An unsaved draft for this is kept on this device:'),
    ).toBeTruthy()
    fireEvent.click(button('Continue the draft')!)
    expect(textarea()!.value).toBe(D_H)
    expect(h.writes()).toEqual([])
  })
})

describe('the delete confirmation names the entry it deletes', () => {
  it('Z3: an entry whose first line is only a heading mark is still named', async () => {
    const h = harness([
      { store: 'memory', content: '#\nStudio keys are in the blue box (fictional).' },
    ])
    await open(/.*/)
    const check = await deleteCheck(h)
    expect(check.offered && check.named).toBeTruthy()
  })
})

describe('focus around adoption and locking', () => {
  it('F1: focus after a successful adoption stays in the editor (not lost to the page)', async () => {
    const h = harness()
    await lockedByMerge(h)
    const adopt = button('Use this draft for the entry now here')!
    adopt.focus()
    fireEvent.click(adopt)
    await settle()
    await settle()
    const after = focusName()
    expect(after).not.toBe('BODY')
  })

  it('F2: focus on "Delete entry…" when the editor locks', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    button('Delete entry…')!.focus()
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    const after = focusName()
    expect(after).not.toBe('BODY')
  })
})

describe('SO2: an involuntary sign-out', () => {
  it('forgets kept memory drafts before another sign-in', async () => {
    window.history.replaceState(null, '', '#/library/memory')
    const scenario = createScenarioClient({ speed: 0 })
    const mem = memoryBackend(fixtureEntries)
    let releaseList: (() => void) | undefined
    let holdList = false
    const listeners = new Set<(event: CindlEvent) => void>()
    const api: CindlClientApi = {
      call: (async (name: string, args: unknown) => {
        if (name === 'memory.entries' && holdList) {
          holdList = false
          await new Promise<void>((resolve) => (releaseList = resolve))
        }
        const op = mem.ops[name]
        if (op) return op(args as never)
        return scenario.call(name as never, args as never)
      }) as CindlClientApi['call'],
      subscribe: (listener) => {
        listeners.add(listener)
        const off = scenario.subscribe(listener)
        return () => {
          listeners.delete(listener)
          off()
        }
      },
    }
    render(
      <CindlProvider api={api}>
        <AppShell />
      </CindlProvider>,
    )
    await settle()
    await settle()
    await open(/The kiln firing log/)
    holdList = true
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    editTo('Edit agent note 2', D_K)
    mem.remove(/kiln firing log/)
    releaseList?.()
    await settle()
    await settle()
    const locked = lockedNow()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const keptBefore = keptMemoryDrafts()
    // Hermes refuses the session (token revoked on the host): the client reports signed-out.
    const at = new Date().toISOString()
    const emit = (link: Record<string, unknown>) =>
      act(() => {
        for (const l of listeners)
          l({
            type: 'link.changed',
            link: { since: at, connectionEpoch: 2, ...link },
          } as unknown as CindlEvent)
      })
    emit({ phase: 'signed-out', demo: false })
    await settle()
    const signIn = Boolean(screen.queryByRole('button', { name: /Sign in/ }))
    const keptAfter = keptMemoryDrafts()
    expect(locked).toBe(true)
    expect(keptBefore).toEqual([D_K])
    expect(signIn).toBe(true)
    expect(keptAfter).toEqual([])
  })
})
