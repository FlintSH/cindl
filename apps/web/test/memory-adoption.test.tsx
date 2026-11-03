// Re-check 5606b13: the reviewer's probes of adoption ("Use this draft for
// the entry now here"), of what a delete confirmation names, and of drafts
// across close, leave and return, kept as regressions with their assertions
// unchanged. The record-only duplicate-text probe is not here: entries with
// identical text share one identity, a documented limit. Synthetic data only.
import { sha256Hex } from '@cindl/client-core'
import { CindlProvider } from '@cindl/client-react'
import { CindlError, type CindlClientApi } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentView } from '../src/agent/AgentView.tsx'
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

/** Memory shaped like the fixture: ids resolve by store and fingerprint (contracts domain.ts). */
function memoryBackend(initial: Entry[]) {
  const entries = initial.map((entry) => ({ ...entry }))
  const ordered = () => [
    ...entries.filter((e) => e.store === 'memory'),
    ...entries.filter((e) => e.store === 'profile'),
  ]
  const idOf = (e: Entry) => `memory:${e.store}:${ordered().indexOf(e)}:${fp(e.content)}`
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
    'memory.write': ({ id, content }: { id: string; content: string }) => {
      const e = find(id)
      e.content = content
      return { id: idOf(e), store: e.store, content, readAt: now(), source: 'probe' }
    },
    'memory.delete': ({ id }: { id: string }) => {
      entries.splice(entries.indexOf(find(id)), 1)
      return { deleted: true }
    },
  }
  return {
    ops,
    add: (store: Store, content: string) => void entries.push({ store, content }),
    remove: (re: RegExp) => void entries.splice(entries.indexOf(byText(re)), 1),
    replace: (re: RegExp, content: string) => void (byText(re).content = content),
    has: (re: RegExp) => entries.some((e) => re.test(e.content)),
    contents: () => ordered().map((e) => `${e.store}: ${e.content.slice(0, 40)}`),
  }
}

type Gate = 'memory.entries' | 'memory.read' | 'memory.write'
function harness(initial = fixtureEntries) {
  const scenario = createScenarioClient({ speed: 0 })
  const mem = memoryBackend(initial)
  const calls: Array<{ name: string; args: unknown }> = []
  const held = new Set<Gate>()
  const releases = new Map<Gate, () => void>()
  let failRead = false
  const api: CindlClientApi = {
    call: (async (name: string, args: unknown) => {
      calls.push({ name, args })
      if (held.has(name as Gate)) {
        held.delete(name as Gate)
        await new Promise<void>((resolve) => releases.set(name as Gate, resolve))
      }
      if (name === 'memory.read' && failRead) {
        failRead = false
        throw new CindlError('unavailable', 'Hermes is not answering.')
      }
      const op = mem.ops[name]
      if (op) return op(args as never)
      return scenario.call(name as never, args as never)
    }) as CindlClientApi['call'],
    subscribe: (listener) => scenario.subscribe(listener),
  }
  const ui = () => (
    <CindlProvider api={api}>
      <LibraryView section="memory" />
    </CindlProvider>
  )
  const view = render(ui())
  return {
    api,
    mem,
    calls,
    writes: () =>
      calls
        .filter((c) => c.name === 'memory.write')
        .map((c) => c.args as { id: string; content: string }),
    deletes: () =>
      calls
        .filter((c) => c.name === 'memory.delete')
        .map((c) => c.args as { id: string }),
    hold: (gate: Gate) => void held.add(gate),
    release: (gate: Gate) => {
      const resolve = releases.get(gate)
      releases.delete(gate)
      resolve?.()
    },
    failNextRead: () => (failRead = true),
    remount: () => {
      view.rerender(<CindlProvider api={api}>{null}</CindlProvider>)
      view.rerender(ui())
    },
    show: (node: React.ReactNode) =>
      view.rerender(<CindlProvider api={api}>{node}</CindlProvider>),
  }
}

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
/** Reload the list from the open editor's view stage, holding the answer. */
const holdListAndReload = async (h: ReturnType<typeof harness>) => {
  h.hold('memory.entries')
  fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
  await settle()
}
const releaseList = async (h: ReturnType<typeof harness>) => {
  h.release('memory.entries')
  await settle()
  await settle()
}
const alerts = () => screen.queryAllByRole('alert').map((a) => a.textContent ?? '')
const lockedNow = () => alerts().some((a) => /cannot tell which/.test(a))
const textarea = () =>
  screen.queryByLabelText<HTMLTextAreaElement>(/^Edit (agent note|note about you) \d$/)
const keptMemoryDrafts = () => keptDocumentDrafts('memory-draft:').map((d) => d.draft)

const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'
const D_H = 'Harbor draft: the offsite date moved to Monday (fictional).'

/** Kiln editor locked by a merge elsewhere (kiln removed, Harbor rewritten), draft D_K in it. */
async function lockedByMerge(h: ReturnType<typeof harness>) {
  await open(/The kiln firing log/)
  await holdListAndReload(h)
  editTo('Edit agent note 2', D_K)
  h.mem.remove(/kiln firing log/)
  h.mem.replace(
    /Harbor Loft/,
    'Harbor Loft (fictional) holds the offsite date until Monday.',
  )
  await releaseList(h)
  expect(lockedNow()).toBe(true)
}

describe('adoption ("Use this draft for the entry now here") followed by a further change', () => {
  it('A1: after adopting and saving, the editor is not locked and offers "Restore previous version"', async () => {
    const h = harness()
    await lockedByMerge(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    const seen = {
      alerts: alerts().map((a) => a.slice(0, 90)),
      restore: Boolean(button('Restore previous version')),
      copyOnly: Boolean(screen.queryByText(/The text your last save replaced/)),
      edit: Boolean(button('Edit')),
      del: Boolean(button('Delete entry…')),
      writes: h.writes().map((w) => w.id),
      store: h.mem.contents(),
    }
    expect(h.mem.has(/Kiln draft/)).toBe(true)
    expect(seen.alerts.some((a) => /cannot tell which/.test(a))).toBe(false)
    expect(seen.restore).toBe(true)
  })

  it('A2: after adopting, a plain renumbering (an agent note removed) is followed, not locked', async () => {
    // Profile store: the brief is removed and the focus note rewritten elsewhere (a merge).
    const h = harness()
    await open(/Prefers a short morning brief/)
    await holdListAndReload(h)
    editTo('Edit note about you 1', 'Brief draft (fictional).')
    h.mem.remove(/morning brief/)
    h.mem.replace(/Protects focus time/, 'Protects focus time before 11:30 on weekdays.')
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    // The owner drops the draft, then reloads while an agent note is removed elsewhere.
    fireEvent.click(button('Discard changes')!)
    await holdListAndReload(h)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    const seen = {
      alerts: alerts().map((a) => a.slice(0, 90)),
      edit: Boolean(button('Edit')),
      del: Boolean(button('Delete entry…')),
    }
    expect(lockedNow()).toBe(false)
    expect(seen.edit).toBe(true)
  })

  it('A3: when the adoption read fails, the draft is still kept after closing', async () => {
    const h = harness()
    await lockedByMerge(h)
    expect(keptMemoryDrafts()).toContain(D_K)
    h.failNextRead()
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const during = {
      alerts: alerts().map((a) => a.slice(0, 90)),
      errorShown: Boolean(screen.queryByText('Hermes is not answering.')),
      adoptAgain: Boolean(button('Use this draft for the entry now here')),
      reloadButtons: screen.queryAllByRole('button', { name: 'Reload' }).length,
      box: textarea()?.value ?? null,
      kept: keptMemoryDrafts(),
    }
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const after = {
      unsavedSection: Boolean(screen.queryByText('Unsaved drafts')),
      draftOnScreen: document.body.textContent?.includes(D_K) ?? false,
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
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    h.release('memory.read')
    await settle()
    const after = {
      unsavedSection: Boolean(screen.queryByText('Unsaved drafts')),
      draftOnScreen: document.body.textContent?.includes(D_K) ?? false,
      kept: keptMemoryDrafts(),
    }
    expect(after.kept).toContain(D_K)
  })

  it('A3c: a failed adoption read is reported, not silent', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.failNextRead()
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(screen.queryByText('Hermes is not answering.')).toBeTruthy()
  })

  it('A4: adopting onto an entry that holds its own kept draft does not silently drop that draft', async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: 'Extra note (fictional).' },
      ...fixtureEntries.slice(3),
    ])
    // 1. A Harbor draft is kept: Glaze is removed, so Extra takes Harbor's place 3.
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(keptMemoryDrafts()).toContain(D_H)
    // 2. A kiln draft is kept: kiln (now place 1) is removed, so Harbor takes place 1.
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    // 3. The owner uses the kiln draft for Harbor, now at place 1.
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const adopted = {
      box: textarea()?.value ?? null,
      keptNotice: Boolean(screen.queryByText(/Your unsaved draft was kept/)),
      kept: keptMemoryDrafts(),
    }
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const after = {
      unsavedSection: Boolean(screen.queryByText('Unsaved drafts')),
      harborDraftOnScreen: document.body.textContent?.includes(D_H) ?? false,
      kept: keptMemoryDrafts(),
      store: h.mem.contents(),
    }
    expect(adopted.keptNotice).toBe(false)
    expect(after.kept).toContain(D_H)
  })

  it('A5: a list change during the adoption read does not unlock the editor beside another entry, and a delete names what it deletes', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(button('Reload and keep my draft')).toBeTruthy()
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    // Locked, with the conflict still showing: the owner reloads and adopts at once.
    h.hold('memory.entries')
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    h.hold('memory.read')
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    // Elsewhere: Glaze removed and a new note appended, so place 2 now holds "Zed".
    h.mem.remove(/Glaze supplier/)
    h.mem.add('memory', 'Zed note about the glaze order (fictional).')
    await releaseList(h)
    h.release('memory.read')
    await settle()
    await settle()
    const seen = {
      locked: lockedNow(),
      box: textarea()?.value.slice(0, 30) ?? null,
      closeLabel: screen
        .queryAllByRole('button', { name: /Close memory entry/ })
        .map((b) => b.getAttribute('aria-label')),
      del: Boolean(button('Delete entry…')),
    }
    let confirmText: string | null = null
    if (seen.del) {
      fireEvent.click(button('Delete entry…')!)
      confirmText = screen.getByRole('group', {
        name: 'Delete this memory entry',
      }).textContent
      fireEvent.click(button('Delete permanently')!)
      await settle()
    }
    if (confirmText) {
      const deletedHarbor = !h.mem.has(/until Monday/)
      const namedHarbor = /Delete “Harbor Loft/.test(confirmText)
      expect(deletedHarbor === namedHarbor).toBe(true)
    }
    expect(h.mem.has(/Zed note/)).toBe(true)
  })

  it('A6: adopting during review does not confirm a diff reviewed against the old entry', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const confirm = button('Confirm and save')
    expect(confirm === null || confirm.disabled).toBe(true)
    expect(h.writes()).toHaveLength(0)
    fireEvent.click(button('Back to editing')!)
    fireEvent.click(button('Review changes')!)
    expect(screen.getByLabelText('Changes').textContent).toContain('until Monday')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(h.writes().map((w) => w.id.split(':')[3])).toEqual([
      fp('Harbor Loft (fictional) holds the offsite date until Monday.'),
    ])
  })
})

describe('adoption keeps every draft until the owner saves or discards it', () => {
  it('R1: edits made after adopting stay kept for the entry the draft was written for when the editor closes unsaved', async () => {
    const h = harness()
    await lockedByMerge(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    const more = `${D_K} One more line (fictional).`
    fireEvent.change(textarea()!, { target: { value: more } })
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(keptMemoryDrafts()).toEqual([more])
    expect(screen.getByText('Unsaved drafts')).toBeTruthy()
    expect(document.body.textContent).toContain(more)
    expect(h.writes()).toHaveLength(0)
  })

  it('R2: an adoption refused because the place changed says so, keeps the draft, and can be retried onto the entry now there', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    h.hold('memory.entries')
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    h.hold('memory.read')
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    expect(screen.getByRole('status').textContent).toBe('Reading the entry now here…')
    expect(lockedNow()).toBe(true)
    expect(button('Delete entry…')).toBeNull()
    expect(button('Use this draft for the entry now here')!.disabled).toBe(true)
    h.mem.remove(/Glaze supplier/)
    h.mem.add('memory', 'Zed note about the glaze order (fictional).')
    await releaseList(h)
    h.release('memory.read')
    await settle()
    await settle()
    expect(lockedNow()).toBe(true)
    expect(alerts()).toContain(
      'The entry at this place changed again while Cindl read it.',
    )
    // The adopt button is described by the entry it would use the draft for.
    const adoptButton = button('Use this draft for the entry now here')!
    const describedBy = adoptButton.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toMatch(
      /Now at this place: “Zed note about the glaze order/,
    )
    expect(keptMemoryDrafts()).toContain(D_K)
    // The owner retries, now for the entry at this place.
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    expect(textarea()!.value).toBe(D_K)
    expect(
      screen.getByText(/This draft was written for the entry that was here before/),
    ).toBeTruthy()
    // R3: discarding it forgets it, and later edits here are this entry's own.
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(keptMemoryDrafts()).not.toContain(D_K)
    editTo('Edit agent note 2', 'A new note for Zed (fictional).')
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(keptMemoryDrafts()).toEqual([])
    expect(h.writes().map((w) => w.id.split(':')[3])).toEqual([fp(KILN)])
    expect(h.deletes()).toHaveLength(0)
    expect(h.mem.has(/Zed note/)).toBe(true)
  })
})

describe('an editor only ever shows the entry it was opened for, or the one the owner chose', () => {
  it('R4: reloading after another entry moved into the place never reads that entry', async () => {
    const h = harness()
    h.failNextRead()
    await open(/The kiln firing log/)
    expect(screen.getByText('Hermes is not answering.')).toBeTruthy()
    // The owner reloads; the list answers after another entry moved into the place.
    h.failNextRead()
    h.hold('memory.entries')
    fireEvent.click(button('Reload')!)
    await settle()
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button('Reload')!)
    await settle()
    await settle()
    const read = h.calls
      .filter((c) => c.name === 'memory.read')
      .map((c) => (c.args as { id: string }).id.split(':')[3])
    expect(read).not.toContain(fp(HARBOR))
    expect(screen.getByText('Another entry is at this place now.')).toBeTruthy()
    expect(button('Delete entry…')).toBeNull()
    expect(textarea()).toBeNull()
  })

  it('R5: a read of the old entry that lands after an adoption locks the editor until the entry now here is read again', async () => {
    const scenario = createScenarioClient({ speed: 0 })
    const LATE = 'Late note about the studio keys (fictional).'
    const D_F = 'Focus draft: protect focus time before 12:00 (fictional).'
    const summary = (id: string, content: string) => ({
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
    const api: CindlClientApi = {
      call: (async (name: string, args: unknown) => {
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
        return scenario.call(name as never, args as never)
      }) as CindlClientApi['call'],
      subscribe: (listener) => scenario.subscribe(listener),
    }
    render(
      <CindlProvider api={api}>
        <LibraryView section="memory" />
      </CindlProvider>,
    )
    await open(/Protects focus time/)
    // An agent note is removed: the focus note keeps its place under a new
    // number, and the editor reads it again; that read is slow.
    listed = [summary(brief(0), BRIEF), summary(focus(1), FOCUS)]
    heldRead = focus(1)
    fireEvent.click(button('Reload')!)
    await settle()
    await settle()
    // The owner edits; the save is refused, and the reload finds another note here.
    editTo('Edit note about you 2', D_F)
    fireEvent.click(button('Review changes')!)
    conflictNextWrite = true
    fireEvent.click(button('Confirm and save')!)
    await settle()
    listed = [summary(focus(0), FOCUS), summary(late, LATE)]
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(true)
    // The owner uses the draft for the note now here.
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    // The slow read of the focus note lands after that. Until the note now
    // here is read again (held here), the editor is locked: the focus note's
    // text is not this entry's, so nothing can be saved or deleted against it.
    heldRead = late
    const releaseFocusRead = releaseRead
    releaseFocusRead?.()
    await settle()
    await settle()
    expect(lockedNow()).toBe(true)
    expect(button('Delete entry…')).toBeNull()
    expect(textarea()!.readOnly).toBe(true)
    expect(keptMemoryDrafts()).toContain(D_F)
    // The note now here is read again, and the editor is bound to it.
    releaseRead?.()
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    fireEvent.click(button('Review changes')!)
    const changes = screen.getByLabelText('Changes').textContent ?? ''
    expect(changes).toContain(LATE)
    expect(changes).not.toContain(FOCUS)
    fireEvent.click(button('Back to editing')!)
    fireEvent.click(button('Delete entry…')!)
    expect(
      screen.getByRole('group', { name: 'Delete this memory entry' }).textContent,
    ).toMatch(/Delete “Late note about the studio keys/)
    fireEvent.click(button('Keep it')!)
    expect(writes).toEqual([focus(2)])
  })
})

describe('the delete confirmation names the entry it deletes', () => {
  it('B: a first read answered after the list moved another entry into the place', async () => {
    const h = harness()
    // The owner deletes Glaze; the list reload that follows is slow.
    await open(/Glaze supplier/)
    fireEvent.click(button('Delete entry…')!)
    h.hold('memory.entries')
    fireEvent.click(button('Delete permanently')!)
    await settle()
    // From the stale list, the owner opens the kiln note; its read is slow too.
    h.hold('memory.read')
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await settle()
    await releaseList(h)
    h.release('memory.read')
    await settle()
    await settle()
    const shown = document.querySelector('pre')?.textContent ?? null
    const seen = {
      locked: lockedNow(),
      editorShows: shown?.slice(0, 40) ?? null,
      closeLabel: screen
        .queryAllByRole('button', { name: /Close memory entry/ })
        .map((b) => b.getAttribute('aria-label')?.slice(0, 50)),
    }
    let confirmText: string | null = null
    if (button('Delete entry…')) {
      fireEvent.click(button('Delete entry…')!)
      confirmText = screen.getByRole('group', {
        name: 'Delete this memory entry',
      }).textContent
      fireEvent.click(button('Delete permanently')!)
      await settle()
    }
    expect(seen.locked).toBe(true)
    expect(button('Edit')).toBeNull()
    expect(seen.editorShows).toMatch(/^The kiln firing log/)
    expect(alerts().join(' ')).toMatch(/The same text is now agent note 1/)
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
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.hold('memory.entries')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    fireEvent.click(button('Delete entry…')!)
    const confirmText =
      screen.getByRole('group', { name: 'Delete this memory entry' }).textContent ?? ''
    fireEvent.click(button('Keep it')!)
    expect(confirmText).toMatch(/Delete “Kiln draft/)
  })

  it('D4: a confirmation left open while the entry is only renumbered never deletes another entry', async () => {
    const h = harness()
    await open(/Prefers a short morning brief/)
    fireEvent.click(button('Delete entry…')!)
    await holdListAndReload(h)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    const stillOpen = Boolean(button('Delete permanently'))
    if (!stillOpen) fireEvent.click(button('Delete entry…')!)
    const confirmText =
      screen.getByRole('group', { name: 'Delete this memory entry' }).textContent ?? ''
    fireEvent.click(button('Delete permanently')!)
    await settle()
    expect(confirmText).toMatch(/Delete “Prefers a short morning brief/)
    expect(h.deletes().map((d) => d.id.split(':')[3])).toEqual([fp(BRIEF)])
    expect(h.mem.has(/Protects focus time/)).toBe(true)
  })
})

describe('drafts across close, leave and return, moves and removals', () => {
  it('D2: an entry moved up with nothing at its old place keeps its draft, which returns only to it', async () => {
    const h = harness()
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    const vanished = {
      locked: lockedNow(),
      removedLabel: Boolean(screen.queryByText('No longer at this place')),
      harborStillListed: h.mem.has(/Harbor Loft/),
    }
    fireEvent.click(button('Close the entry no longer at this place')!)
    await settle()
    const closed = { unsavedSection: Boolean(screen.queryByText('Unsaved drafts')) }
    await open(/Harbor Loft/)
    const reopened = {
      box: textarea()?.value ?? null,
      label: textarea()?.labels?.[0]?.textContent ?? null,
      keptNotice: Boolean(screen.queryByText(/Your unsaved draft was kept/)),
    }
    // The entry now at place 1 (kiln) opens clean.
    fireEvent.click(button(/Close memory entry: Harbor/)!)
    await open(/The kiln firing log/)
    const kiln = { box: textarea()?.value ?? null }
    expect(vanished.removedLabel).toBe(true)
    expect(vanished.harborStillListed).toBe(true)
    expect(closed.unsavedSection).toBe(false)
    expect(reopened.box).toBe(D_H)
    expect(kiln.box).toBeNull()
  })

  it('D3: two kept drafts for two removed entries are both listed, and discarding one keeps the other', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_H)
    h.mem.remove(/Harbor Loft/)
    await releaseList(h)
    fireEvent.click(button('Close the entry no longer at this place')!)
    await settle()
    const listed = screen.getAllByRole('button', { name: /^Discard draft/ }).length
    const discardNames = screen
      .getAllByRole('button', { name: /^Discard draft/ })
      .map((b) => b.getAttribute('aria-label'))
    const both = [D_K, D_H].map((d) => document.body.textContent?.includes(d))
    fireEvent.click(screen.getAllByRole('button', { name: /^Discard draft/ })[0]!)
    await settle()
    const left = [D_K, D_H].map((d) => document.body.textContent?.includes(d))
    expect(listed).toBe(2)
    expect(both).toEqual([true, true])
    expect(new Set(discardNames).size).toBe(2)
    expect(left.filter(Boolean)).toHaveLength(1)
    expect(h.writes()).toHaveLength(0)
  })

  it('G: leaving the page while a locked editor is open keeps its draft for the list', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.remount()
    await settle()
    await settle()
    const seen = {
      unsaved: Boolean(screen.queryByText('Unsaved drafts')),
      draft: document.body.textContent?.includes(D_K),
    }
    expect(seen.draft).toBe(true)
  })

  it('I: an emptied store keeps the row until closed, then the draft is listed and the store heading goes', async () => {
    const h = harness(fixtureEntries.filter((e) => e.store === 'memory'))
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze/)
    h.mem.remove(/kiln/)
    h.mem.remove(/Harbor/)
    await releaseList(h)
    const vanished = {
      row: Boolean(screen.queryByText('No longer at this place')),
      box: textarea()?.value ?? null,
      empty: Boolean(screen.queryByText(/no memory entries yet/)),
    }
    fireEvent.click(button('Close the entry no longer at this place')!)
    await settle()
    const closed = {
      heading: Boolean(screen.queryByText('Agent notes')),
      unsaved: Boolean(screen.queryByText('Unsaved drafts')),
      draft: document.body.textContent?.includes(D_H),
    }
    expect(vanished.box).toBe(D_H)
    expect(closed.heading).toBe(false)
    expect(closed.draft).toBe(true)
  })

  it("N9b: the owner's save racing the removal of the very entry saved shows the replaced text", async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.hold('memory.entries')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    // Elsewhere the agent removes the note the owner just saved.
    h.mem.remove(/Kiln draft/)
    await releaseList(h)
    const seen = {
      alerts: alerts().map((a) => a.slice(0, 60)),
      replacedShown: document.body.textContent?.includes(KILN) ?? false,
      restore: Boolean(button('Restore previous version')),
    }
    expect(seen.replacedShown).toBe(true)
    expect(seen.restore).toBe(false)
  })
})

describe('sign-out', () => {
  it('forgets kept memory drafts', async () => {
    const h = harness()
    await lockedByMerge(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(keptMemoryDrafts()).toContain(D_K)
    h.show(<AgentView section="device" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out on this device' }))
    await settle()
    await settle()
    const signedOut = Boolean(screen.queryByText('Signed out on this device.'))
    h.show(<LibraryView section="memory" />)
    await settle()
    await settle()
    expect(signedOut).toBe(true)
    expect(keptMemoryDrafts()).toEqual([])
    expect(document.body.textContent?.includes(D_K)).toBe(false)
  })
})

describe('SOUL and skills in the real shell (hash routes remount the view)', () => {
  function shellHarness() {
    const scenario = createScenarioClient({ speed: 0 })
    const calls: Array<{ name: string; args: unknown }> = []
    let releaseWrite: (() => void) | undefined
    let holdWrite: string | undefined
    const api: CindlClientApi = {
      call: async (name: string, args: unknown) => {
        calls.push({ name, args })
        if (name === holdWrite) {
          holdWrite = undefined
          await new Promise<void>((resolve) => (releaseWrite = resolve))
        }
        return scenario.call(name as never, args as never)
      },
      subscribe: (listener) => scenario.subscribe(listener),
    }
    return {
      scenario,
      calls,
      holdNext: (name: string) => (holdWrite = name),
      releaseWrite: () => releaseWrite?.(),
      render: () =>
        render(
          <CindlProvider api={api}>
            <AppShell />
          </CindlProvider>,
        ),
    }
  }
  const goTo = async (hash: string) => {
    window.location.hash = hash
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await settle()
    await settle()
  }

  it('S2h: a skill save finishing after a hash change to another skill keeps that skill and its draft', async () => {
    window.history.replaceState(null, '', '#/library/skills/calendar-triage')
    const s = shellHarness()
    s.render()
    await settle()
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const a = screen.getByLabelText<HTMLTextAreaElement>('Edit skill:calendar-triage')
    fireEvent.change(a, { target: { value: `${a.value}\nOne more step (fictional).` } })
    fireEvent.click(button('Review changes')!)
    s.holdNext('skills.write')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await goTo('#/library/skills/inventory-sheets')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const b = screen.getByLabelText<HTMLTextAreaElement>('Edit skill:inventory-sheets')
    fireEvent.change(b, {
      target: { value: 'Draft for the inventory skill (fictional).' },
    })
    s.releaseWrite()
    await settle()
    await settle()
    const after = screen.queryByLabelText<HTMLTextAreaElement>(
      'Edit skill:inventory-sheets',
    )
    const writes = s.calls
      .filter((c) => c.name === 'skills.write')
      .map((c) => (c.args as { name: string }).name)
    expect(after?.value).toBe('Draft for the inventory skill (fictional).')
    expect(writes).toEqual(['calendar-triage'])
    // Back on the first skill, the saved text is what is shown.
    await goTo('#/library/skills/calendar-triage')
    expect(document.body.textContent).toContain('One more step (fictional).')
  })

  it('S3h: a SOUL save finishing after leaving and returning does not reset the new draft', async () => {
    window.history.replaceState(null, '', '#/agent/identity')
    const s = shellHarness()
    s.render()
    await settle()
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText<HTMLTextAreaElement>(/^Edit soul/)
    fireEvent.change(box, {
      target: { value: `${box.value}\nA saved line (fictional).` },
    })
    fireEvent.click(button('Review changes')!)
    s.holdNext('soul.write')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await goTo('#/agent/runtime')
    await goTo('#/agent/identity')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const again = screen.getByLabelText<HTMLTextAreaElement>(/^Edit soul/)
    fireEvent.change(again, {
      target: { value: `${again.value}\nA second draft (fictional).` },
    })
    s.releaseWrite()
    await settle()
    await settle()
    const after = screen.queryByLabelText<HTMLTextAreaElement>(/^Edit soul/)
    expect(after?.value).toContain('A second draft (fictional).')
  })
})
