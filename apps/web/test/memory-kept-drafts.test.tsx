// Re-check 5d0be84: the reviewer's probes of the kept-draft model, a refused
// adoption, sign-out, focus and naming, kept as regressions with their
// assertions unchanged (P5b-P5f failed before the focus and naming fix).
// Not copied: P1d (already in memory-drafts.test.tsx), and P1b and P6a, which
// expect what the old hints promised. The hints were rewritten instead (an
// entry's own kept draft is the one that returns with it, and a draft goes
// back to the entry it was written for while Hermes lists it); R10 and R11 in
// memory-transport-2.test.tsx run those flows and assert where each draft
// goes. Synthetic data only.
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
const EXTRA = 'Extra note about the studio van (fictional).'
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

// ---- review 5d0be84 additions -------------------------------------------------------
const A_NOTE = 'Archive shelf note (fictional).'
const B_NOTE = 'Bench note (fictional).'
const WED = 'Harbor Loft (fictional) holds the offsite date until Wednesday.'
const FRESH = 'Harbor fresh draft: the offsite moves to Thursday (fictional).'
const five = (): Entry[] => [
  { store: 'memory', content: A_NOTE },
  { store: 'memory', content: B_NOTE },
  { store: 'memory', content: KILN },
  { store: 'memory', content: HARBOR },
  { store: 'memory', content: EXTRA },
  ...fixtureEntries.slice(3),
]
const describedBy = (el: HTMLElement | null) => {
  const id = el?.getAttribute('aria-describedby')
  return id ? (document.getElementById(id)?.textContent ?? `MISSING #${id}`) : null
}
const count = (h: H, name: string) => h.calls.filter((c) => c.name === name).length
const offerShown = () =>
  Boolean(screen.queryByText('An unsaved draft for this is kept on this device:'))
const anotherNote = () =>
  Boolean(screen.queryByText(/Another unsaved draft for this is kept on this device/))

/**
 * Harbor's own draft D_H is kept (an earlier lock), the kiln draft is used for
 * Harbor and then discarded, so Harbor shows in view with D_H offered. Entries
 * `five()`: afterwards memory is [Bench, Harbor, Extra] and Harbor is place 2.
 */
async function harborOwnDraftOffered(h: H) {
  await open(/Harbor Loft/)
  await holdListAndReload(h)
  editTo('Edit agent note 4', D_H)
  h.mem.remove(/Archive shelf/)
  await releaseList(h)
  expect(lockedNow()).toBe(true)
  fireEvent.click(button(/Close memory entry/)!)
  await settle()
  await open(/The kiln firing log/)
  await holdListAndReload(h)
  editTo('Edit agent note 2', D_K)
  h.mem.remove(/kiln firing log/)
  await releaseList(h)
  expect(lockedNow()).toBe(true)
  fireEvent.click(button('Use this draft for the entry now here')!)
  await settle()
  await settle()
  expect(lockedNow()).toBe(false)
  fireEvent.click(button('Discard changes')!)
  await settle()
  expect(offerShown()).toBe(true)
}

describe('P1: the kept-draft model (SF1 variants)', () => {
  it('P1a: X1 path, then Continue the draft, review and save: Harbor gets D_H and no kept draft is left or lost', async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    fireEvent.click(button('Continue the draft')!)
    const seen = {
      box: textarea()?.value,
      keptNote: Boolean(screen.queryByText(/^Your unsaved draft was kept\./)),
      another: anotherNote(),
    }
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    const after = {
      kept: keptKeys(),
      writes: h.writes().map((w) => w.content),
      store: h.mem.contents(),
    }
    expect(seen.box).toBe(D_H)
    expect(after.writes).toEqual([D_H])
    expect(after.kept).toEqual([])
  })

  it("P1c: fresh text filed beside Harbor's draft, then used for another entry: nothing claims Harbor's draft is that entry's", async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    await holdListAndReload(h)
    editTo('Edit agent note 2', FRESH)
    // Elsewhere Harbor is removed: Extra is at place 2 now.
    h.mem.remove(/Harbor Loft/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const adopted = {
      locked: lockedNow(),
      box: textarea()?.value ?? null,
      statusNotes: Array.from(document.querySelectorAll('[role="status"]')).map((n) =>
        n.textContent?.slice(0, 120),
      ),
      another: anotherNote(),
      ownDraftNote: Boolean(
        screen.queryByText(/This entry also has an unsaved draft of its own/),
      ),
      extraHasOwnDraft: keptKeys().includes(`memory-draft:memory:${fp(EXTRA)}`),
    }
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    const saved = {
      kept: keptMemoryDrafts(),
      writes: h.writes().map((w) => w.content),
      store: h.mem.contents(),
    }
    expect(saved.writes).toEqual([FRESH])
    expect(saved.kept).toEqual([D_H])
    // Extra has no kept draft of its own; D_H was written for Harbor.
    expect(adopted.another).toBe(false)
  })

  it('P1e: Discard the draft forgets only the offered draft; Edit, Discard changes and reopen keep the rest', async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    const before = keptKeys()
    fireEvent.click(button('Discard the draft')!)
    await settle()
    const after = { kept: keptKeys(), offer: offerShown(), edit: Boolean(button('Edit')) }
    expect(before).toEqual([`memory-draft:memory:${fp(HARBOR)}`])
    expect(after.kept).toEqual([])
    expect(after.offer).toBe(false)
    expect(h.writes()).toEqual([])
  })

  it('P1f: a conflict on a fresh edit beside an offered draft files it once beside D_H; Back to editing keeps that key (no third copy)', async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    editTo('Edit agent note 2', FRESH)
    fireEvent.click(button('Review changes')!)
    h.failNext('memory.write', new CindlError('conflict', 'Probe conflict one.'))
    fireEvent.click(button('Confirm and save')!)
    await settle()
    const first = keptKeys()
    fireEvent.click(button('Back to editing')!)
    fireEvent.change(textarea()!, { target: { value: `${FRESH} More.` } })
    fireEvent.click(button('Review changes')!)
    expect(first).toEqual([
      `memory-draft:memory:${fp(HARBOR)}`,
      `memory-draft:memory:${fp(HARBOR)}#2`,
    ])
    expect(keptMemoryDrafts()).toEqual([D_H, FRESH])
  })

  it('P1g: a lock that lands while a save is in flight files the draft, and the save then fails with a conflict: one kept copy, not two', async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    await holdListAndReload(h)
    editTo('Edit agent note 2', FRESH)
    fireEvent.click(button('Review changes')!)
    h.hold('memory.write')
    h.failNext(
      'memory.write',
      new CindlError(
        'conflict',
        'This memory entry changed since you read it. Reload it and review again.',
      ),
    )
    fireEvent.click(button('Confirm and save')!)
    await settle()
    // Elsewhere Bench is removed: Harbor moves up, Extra takes place 2; the list lands first.
    h.mem.remove(/Bench note/)
    await releaseList(h)
    h.release('memory.write')
    await settle()
    await settle()
    const after = { keys: keptKeys(), drafts: keptMemoryDrafts() }
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(after.drafts.filter((d) => d === FRESH)).toHaveLength(1)
  })
})

describe('P2: a refused adoption fetches the list (SF2 variants)', () => {
  it('P2a: the list fetched after a refusal lands during the next adoption read; the read is refused, fetched again, and the third try uses the entry now here', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.mem.replace(/Harbor Loft/, WED)
    const lists0 = count(h, 'memory.entries')
    h.hold('memory.entries')
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const refused1 = {
      alerts: alerts().map((a) => a.slice(0, 70)),
      lists: count(h, 'memory.entries') - lists0,
      desc: describedBy(button('Use this draft for the entry now here')),
    }
    h.hold('memory.read')
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await releaseList(h)
    const listLanded = {
      desc: describedBy(button('Use this draft for the entry now here')),
      locked: lockedNow(),
      busyStill: Boolean(screen.queryByText('Reading the entry now here…')),
    }
    h.release('memory.read')
    await settle()
    await settle()
    const refused2 = {
      alerts: alerts().map((a) => a.slice(0, 70)),
      lists: count(h, 'memory.entries') - lists0,
      kept: keptMemoryDrafts(),
    }
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const third = {
      locked: lockedNow(),
      box: textarea()?.value ?? null,
      focus: focusName(),
    }
    for (let i = 0; i < 5; i++) await settle()
    const quiet = { lists: count(h, 'memory.entries') - lists0, reads: h.reads().length }
    fireEvent.click(button('Review changes')!)
    const diff = screen.getByLabelText('Changes').textContent ?? ''
    expect(refused1.lists).toBe(1)
    expect(listLanded.desc).toMatch(/Wednesd/)
    expect(refused2.lists).toBe(2)
    expect(third.locked).toBe(false)
    expect(third.box).toBe(D_K)
    expect(diff).toContain('Wednesday')
    expect(quiet.lists).toBe(2)
    expect(h.writes()).toEqual([])
  })

  it('P2b: the adoption read succeeds but the list (reloaded meanwhile) shows another entry: refused without a fetch, and the next try uses that entry', async () => {
    const h = harness([
      ...fixtureEntries.slice(0, 3),
      { store: 'memory', content: EXTRA },
      ...fixtureEntries.slice(3),
    ])
    await lockedByMerge(h)
    h.holdAnswer('memory.read')
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    h.mem.remove(/Harbor Loft/)
    const lists0 = count(h, 'memory.entries')
    fireEvent.click(button('Reload')!)
    await settle()
    await settle()
    h.release('memory.read')
    await settle()
    await settle()
    const refused = {
      alerts: alerts().map((a) => a.slice(0, 70)),
      lists: count(h, 'memory.entries') - lists0,
      desc: describedBy(button('Use this draft for the entry now here')),
    }
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const next = { locked: lockedNow(), box: textarea()?.value ?? null }
    expect(refused.alerts.join(' ')).toMatch(/changed again while Cindl read it/)
    expect(refused.desc).toMatch(/Extra note/)
    expect(next.locked).toBe(false)
    expect(next.box).toBe(D_K)
  })

  it('P2c: a refusal whose list fetch fails: the owner is told, nothing loops, and a later try recovers', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.mem.replace(/Harbor Loft/, WED)
    const lists0 = count(h, 'memory.entries')
    h.failNext(
      'memory.entries',
      new CindlError('unavailable', 'Hermes is not answering the list.'),
    )
    fireEvent.click(button('Use this draft for the entry now here')!)
    for (let i = 0; i < 4; i++) await settle()
    const first = {
      alerts: alerts().map((a) => a.slice(0, 70)),
      listError: Boolean(screen.queryByText('Hermes is not answering the list.')),
      lists: count(h, 'memory.entries') - lists0,
      reads: h.reads().length,
      desc: describedBy(button('Use this draft for the entry now here')),
    }
    fireEvent.click(button('Use this draft for the entry now here')!)
    for (let i = 0; i < 4; i++) await settle()
    const second = {
      lists: count(h, 'memory.entries') - lists0,
      desc: describedBy(button('Use this draft for the entry now here')),
    }
    fireEvent.click(button('Use this draft for the entry now here')!)
    for (let i = 0; i < 4; i++) await settle()
    const third = {
      locked: lockedNow(),
      lists: count(h, 'memory.entries') - lists0,
      kept: keptMemoryDrafts(),
    }
    expect(first.lists).toBe(1)
    expect(second.lists).toBe(2)
    expect(third.locked).toBe(false)
  })

  it('P2d: a read that fails for another reason (unavailable) does not fetch the list, and can be retried', async () => {
    const h = harness()
    await lockedByMerge(h)
    const lists0 = count(h, 'memory.entries')
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const first = {
      lists: count(h, 'memory.entries') - lists0,
      alerts: alerts().map((a) => a.slice(0, 60)),
    }
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(first.lists).toBe(0)
    expect(lockedNow()).toBe(false)
  })
})

describe('P4: sign-out of either kind', () => {
  function shell() {
    window.history.replaceState(null, '', '#/library/memory')
    const scenario = createScenarioClient({ speed: 0 })
    const mem = memoryBackend(fixtureEntries)
    const gate: { list?: () => void; holdList: boolean } = { holdList: false }
    const listeners = new Set<(event: CindlEvent) => void>()
    const api: CindlClientApi = {
      call: (async (name: string, args: unknown) => {
        if (name === 'memory.entries' && gate.holdList) {
          gate.holdList = false
          await new Promise<void>((resolve) => (gate.list = resolve))
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
    const at = new Date().toISOString()
    const emit = (link: Record<string, unknown>) =>
      act(() => {
        for (const l of listeners)
          l({
            type: 'link.changed',
            link: { since: at, connectionEpoch: 2, ...link },
          } as unknown as CindlEvent)
      })
    return { mem, gate, emit }
  }
  async function lockAndAdoptInShell(s: ReturnType<typeof shell>) {
    await settle()
    await settle()
    await open(/The kiln firing log/)
    s.gate.holdList = true
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    editTo('Edit agent note 2', D_K)
    s.mem.remove(/kiln firing log/)
    s.mem.replace(/Harbor Loft/, HARBOR_MON)
    s.gate.list?.()
    await settle()
    await settle()
    expect(lockedNow()).toBe(true)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
  }

  it('P4a: Hermes refuses the session while an adopted draft is open: drafts are forgotten, and none returns after the next sign-in', async () => {
    const s = shell()
    await lockAndAdoptInShell(s)
    const before = keptMemoryDrafts()
    s.emit({ phase: 'signed-out', demo: false })
    await settle()
    const signedOut = {
      kept: keptMemoryDrafts(),
      signIn: Boolean(screen.queryByRole('button', { name: /Sign in/ })),
    }
    s.emit({ phase: 'online', demo: false })
    await settle()
    await settle()
    const back = {
      kept: keptMemoryDrafts(),
      unsaved: Boolean(screen.queryByText('Unsaved drafts')),
      draftOnScreen: document.body.textContent?.includes(D_K) ?? false,
    }
    expect(before).toEqual([D_K])
    expect(signedOut.kept).toEqual([])
    expect(back.kept).toEqual([])
    expect(back.draftOnScreen).toBe(false)
  })

  it('P4b: a reconnect (not a sign-out) keeps the kept drafts', async () => {
    const s = shell()
    await lockAndAdoptInShell(s)
    s.emit({ phase: 'reconnecting', demo: false })
    await settle()
    s.emit({ phase: 'online', demo: false })
    await settle()
    expect(keptMemoryDrafts()).toEqual([D_K])
  })
})

describe('P5: accessibility of the new controls', () => {
  it('P5a: the adopt button is described by the entry now here when idle, busy and refused', async () => {
    const h = harness()
    await lockedByMerge(h)
    const btn = () => button('Use this draft for the entry now here')
    const idle = {
      name: btn()?.textContent,
      desc: describedBy(btn()),
      id: btn()?.getAttribute('aria-describedby'),
    }
    h.hold('memory.read')
    fireEvent.click(btn()!)
    await settle()
    const busy = { desc: describedBy(btn()), disabled: btn()?.disabled }
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    h.release('memory.read')
    await settle()
    await settle()
    const refused = { desc: describedBy(btn()) }
    expect(idle.desc).toMatch(
      /Harbor Loft \(fictional\) holds the offsite date until Monday/,
    )
    expect(busy.desc).toMatch(/Harbor Loft/)
    expect(refused.desc).toMatch(/Harbor Loft/)
  })

  it('P5b: focus after Continue the draft, Discard the draft and Discard changes stays in the editor', async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    const afterDiscardChanges = focusName()
    button('Continue the draft')!.focus()
    fireEvent.click(button('Continue the draft')!)
    await settle()
    const afterContinue = focusName()
    fireEvent.click(button('Discard changes')!)
    await settle()
    // Discarding the continued draft forgets it, so nothing is offered now; set one up again.
    expect(afterContinue).not.toBe('BODY')
    expect(afterDiscardChanges).not.toBe('BODY')
  })

  it('P5c: Discard the draft keeps focus in the editor', async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    button('Discard the draft')!.focus()
    fireEvent.click(button('Discard the draft')!)
    await settle()
    const after = focusName()
    expect(after).not.toBe('BODY')
  })

  it('P5d: two kept drafts with the same first line get different discard names', async () => {
    const LINE2A = `${HARBOR}\nBring the van keys (fictional).`
    const LINE2B = `${HARBOR}\nBook the ferry (fictional).`
    const h = harness(five())
    // Harbor's own draft LINE2A is kept by a lock.
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 4', LINE2A)
    h.mem.remove(/Archive shelf/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    // A kiln draft is used for Harbor and discarded: LINE2A is offered.
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    fireEvent.click(button('Discard changes')!)
    await settle()
    // A fresh edit with the same first line is filed beside LINE2A when Harbor is removed.
    await holdListAndReload(h)
    editTo('Edit agent note 2', LINE2B)
    h.mem.remove(/Harbor Loft/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const names = screen
      .queryAllByRole('button', { name: /^Discard draft/ })
      .map((b) => b.getAttribute('aria-label'))
    expect(names.length).toBe(2)
    expect(new Set(names).size).toBe(2)
  })
})

describe('P5 (more): focus around the new refusal and adoption paths', () => {
  it('P5e: focus on the adopt button; the refusal fetches the list and the place is now empty, so the button goes: focus is not dropped to the page', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.mem.remove(/Harbor Loft/)
    const adopt = button('Use this draft for the entry now here')!
    adopt.focus()
    fireEvent.click(adopt)
    for (let i = 0; i < 4; i++) await settle()
    const seen = {
      adoptStill: Boolean(button('Use this draft for the entry now here')),
      focus: focusName(),
      locked: lockedNow(),
      kept: keptMemoryDrafts(),
      lists: h.calls.filter((c) => c.name === 'memory.entries').length,
    }
    expect(seen.adoptStill).toBe(false)
    expect(seen.kept).toEqual([D_K])
    expect(seen.focus).not.toBe('BODY')
  })

  it('P5f: the owner moves focus elsewhere while the adoption read is out; when it completes, focus stays where the owner put it', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.hold('memory.read')
    const adopt = button('Use this draft for the entry now here')!
    adopt.focus()
    fireEvent.click(adopt)
    await settle()
    // The owner moves on to another entry's Open button.
    const other = screen.getByRole('button', {
      name: /Open memory entry: Glaze supplier/,
    })
    other.focus()
    const before = focusName()
    h.release('memory.read')
    await settle()
    await settle()
    const after = focusName()
    expect(lockedNow()).toBe(false)
    expect(after).toBe(before)
  })
})

describe('P9: a failed adoption read, then a retry (mutation K7b check)', () => {
  it('P9: after a failed read and a successful retry, the draft is still marked as written for another entry and kept while edited', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const adopted = {
      locked: lockedNow(),
      note: Boolean(
        screen.queryByText(/This draft was written for the entry that was here before/),
      ),
    }
    fireEvent.change(textarea()!, { target: { value: `${D_K} Edited after adopting.` } })
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const closed = { kept: keptMemoryDrafts() }
    expect(adopted.locked).toBe(false)
    expect(adopted.note).toBe(true)
    expect(closed.kept).toEqual([`${D_K} Edited after adopting.`])
  })
})

describe('P10: the restore path (mutation q09 check)', () => {
  it("P10: a draft kept by a lock and restored at the entry's new place says it was kept, and saving it forgets it", async () => {
    const h = harness()
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 3', D_H)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button('Close the entry no longer at this place')!)
    await settle()
    await open(/Harbor Loft/)
    const restored = {
      box: textarea()?.value ?? null,
      keptNote: Boolean(screen.queryByText(/^Your unsaved draft was kept\./)),
      another: Boolean(
        screen.queryByText(/Another unsaved draft for this is kept on this device/),
      ),
    }
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    const saved = { kept: keptMemoryDrafts(), writes: h.writes().map((w) => w.content) }
    expect(restored.box).toBe(D_H)
    expect(restored.keptNote).toBe(true)
    expect(restored.another).toBe(false)
    expect(saved.writes).toEqual([D_H])
    expect(saved.kept).toEqual([])
  })
})

// Re-check 5d0be84, note 4: guards no test caught (its mutations q04, q06,
// q07, q12, q15, q17, q18 and M4), and where focus lands.
describe('guards the re-check found unpinned', () => {
  it('R14: focus moves with the step: Edit into the draft, Review changes onto the changes, Back to editing into the draft, Discard changes onto Edit', async () => {
    harness()
    await open(/The kiln firing log/)
    button('Edit')!.focus()
    fireEvent.click(button('Edit')!)
    await settle()
    expect(document.activeElement).toBe(textarea())
    fireEvent.change(textarea()!, { target: { value: D_K } })
    button('Review changes')!.focus()
    fireEvent.click(button('Review changes')!)
    await settle()
    expect(document.activeElement).toBe(screen.getByLabelText('Changes'))
    button('Back to editing')!.focus()
    fireEvent.click(button('Back to editing')!)
    await settle()
    expect(document.activeElement).toBe(textarea())
    button('Discard changes')!.focus()
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(document.activeElement).toBe(button('Edit'))
  })

  it('R15: a lock that removes the focused "Delete entry…" (beside the editor\'s steps) puts focus on the lock notice, which says why', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    button('Delete entry…')!.focus()
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    expect(document.activeElement?.textContent).toMatch(/cannot tell which/)
  })

  it('R16: a draft kept by a conflict is forgotten once it is saved after "Reload and keep my draft"', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.failNext('memory.write', new CindlError('conflict', 'Probe conflict.'))
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(keptMemoryDrafts()).toEqual([D_K])
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    expect(h.mem.has(/Kiln draft/)).toBe(true)
    expect(keptMemoryDrafts()).toEqual([])
  })

  it('R17: a draft kept by a conflict is forgotten when it is discarded after "Back to editing"', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.failNext('memory.write', new CindlError('conflict', 'Probe conflict.'))
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(keptMemoryDrafts()).toEqual([D_K])
    fireEvent.click(button('Back to editing')!)
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(keptMemoryDrafts()).toEqual([])
    expect(h.writes()).toHaveLength(1)
  })

  it('R18: an adoption refused because the entry now here is not found fetches the list, as a conflict does', async () => {
    const h = harness()
    await lockedByMerge(h)
    const lists = count(h, 'memory.entries')
    h.failNext(
      'memory.read',
      new CindlError('not-found', 'This memory entry is not in Hermes any more.'),
    )
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(alerts().join(' ')).toMatch(/not in Hermes any more/)
    expect(count(h, 'memory.entries') - lists).toBe(1)
    expect(keptMemoryDrafts()).toEqual([D_K])
  })

  it('R19: a discard while an adoption read is out clears "Reading the entry now here…", and that read failing later shows no error', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.holdAnswer('memory.read')
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    expect(screen.queryByText('Reading the entry now here…')).not.toBeNull()
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(screen.queryByText('Reading the entry now here…')).toBeNull()
    h.release('memory.read')
    await settle()
    await settle()
    expect(screen.queryByText('Hermes is not answering.')).toBeNull()
    expect(screen.queryByText('Reading the entry now here…')).toBeNull()
  })

  it("R20: while the editor is locked, an entry's own kept draft is not offered", async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(true)
    expect(offerShown()).toBe(false)
    expect(button('Continue the draft')).toBeNull()
  })

  it('R21: a draft used for an entry that has its own kept draft says so once', async () => {
    const h = harness(five())
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 4', D_H)
    h.mem.remove(/Archive shelf/)
    await releaseList(h)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    expect(
      screen.queryAllByText(/This entry also has an unsaved draft of its own/),
    ).toHaveLength(1)
    expect(anotherNote()).toBe(false)
  })
})

// Re-check 5d0be84, note 4: the predecessor's mutations that still survived
// (K7b, N5, N6, N9, N11, N16) and the numbering of identical drafts.
describe('older guards still unpinned', () => {
  it('R22: a failed adoption read leaves the editor bound to its own entry: a later renumbering neither reads nor unlocks onto the entry now here', async () => {
    const FOCUS_NEW =
      'Protects focus time before 10:00 on weekdays (rewritten, fictional).'
    const D_F = 'Focus draft: protect mornings until noon (fictional).'
    const h = harness()
    await open(/Protects focus time/)
    await holdListAndReload(h)
    editTo('Edit note about you 2', D_F)
    h.mem.replace(/Protects focus time/, FOCUS_NEW)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(alerts().join(' ')).toMatch(/Hermes is not answering/)
    const reads = h.reads().length
    // Elsewhere an agent note is removed: the note now here keeps its place under a new number.
    h.mem.remove(/Glaze supplier/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(true)
    expect(h.reads()).toHaveLength(reads)
    expect(textarea()?.value).toBe(D_F)
  })

  it('R23: after a save, while the list still shows the replaced text, the editor does not read the replaced id (Hermes would refuse it)', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    const replaced = `memory:memory:1:${fp(KILN)}`
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.hold('memory.entries')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    expect(h.reads().filter((id) => id === replaced)).toHaveLength(1)
    expect(button('Restore previous version')).not.toBeNull()
    await releaseList(h)
    expect(h.reads().filter((id) => id === replaced)).toHaveLength(1)
    expect(screen.queryByText(/changed since you read it/)).toBeNull()
  })

  it('R24: the delete confirmation cuts a long first line at 80 characters, as Hermes cuts card titles', async () => {
    const LONG =
      'Van keys: the studio van keys hang on the hook by the kiln room door, next to the glaze shelf (fictional).'
    harness([{ store: 'memory', content: LONG }, ...fixtureEntries.slice(1)])
    await open(/Van keys/)
    fireEvent.click(button('Delete entry…')!)
    expect(
      screen.getByRole('group', { name: 'Delete this memory entry' }).textContent,
    ).toContain(`Delete “${LONG.slice(0, 80)}…” from Hermes`)
  })

  it('R25: once a draft used for the entry now here is saved, it is that entry’s text: the next edit carries no note about another entry and is not kept', async () => {
    const h = harness()
    await lockedByMerge(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(
      screen.queryByText(/This draft was written for the entry that was here before/),
    ).not.toBeNull()
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    expect(h.writes().map((w) => w.content)).toEqual([D_K])
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: `${D_K} Later.` } })
    await settle()
    expect(
      screen.queryByText(/This draft was written for the entry that was here before/),
    ).toBeNull()
    expect(keptMemoryDrafts()).toEqual([])
  })

  it('R26: when two entries have the moved entry’s text, the lock names no place for it', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    // Glaze is removed (the kiln note moves up) and a copy of the kiln note is added at the end.
    h.mem.remove(/Glaze supplier/)
    h.mem.add('memory', KILN)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    expect(alerts().join(' ')).not.toMatch(/The same text is now/)
  })

  it('R27: a failed adoption read says the draft was not used and is still kept', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(
      screen.queryByText('Your draft was not used, and it is still kept.'),
    ).not.toBeNull()
    expect(keptMemoryDrafts()).toEqual([D_K])
  })

  it('R28: two kept drafts with identical text get different discard names', async () => {
    const SAME = 'Same draft for two notes (fictional).'
    const h = harness()
    await open(/Glaze supplier/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', SAME)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button(/Close/)!)
    await settle()
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', SAME)
    h.mem.remove(/Harbor Loft/)
    await releaseList(h)
    fireEvent.click(button(/Close/)!)
    await settle()
    const names = screen
      .queryAllByRole('button', { name: /^Discard draft/ })
      .map((b) => b.getAttribute('aria-label'))
    expect(keptMemoryDrafts()).toEqual([SAME, SAME])
    expect(names).toEqual([
      'Discard draft 1 of 2: Same draft for two notes (fictional).',
      'Discard draft 2 of 2: Same draft for two notes (fictional).',
    ])
  })
})
