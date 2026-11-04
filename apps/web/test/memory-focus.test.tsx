// Re-check e395d03: the reviewer's probes of focus around the memory editor
// (including what a browser does when the focused control is disabled, which
// jsdom does not), names, keyed steps and the three mutations an earlier pass
// let survive (q02, N19, F8), kept as regressions with their assertions
// unchanged. Its harness is memory-kept-drafts.test.tsx's, with card titles
// following Hermes's rule. Q3a, Q3b and Q4a only observed; R29 and R30 below
// assert what they observed. Synthetic data only.
import { sha256Hex } from '@cindl/client-core'
import { CindlProvider } from '@cindl/client-react'
import { CindlError, type CindlClientApi } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryView } from '../src/library/LibraryView.tsx'
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
        title: (() => {
          const first = (e.content.split('\n')[0] ?? '').trim().replace(/^#+\s*/, '')
          return first.length > 80 ? `${first.slice(0, 80)}…` : first
        })(),
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
const five = (): Entry[] => [
  { store: 'memory', content: A_NOTE },
  { store: 'memory', content: B_NOTE },
  { store: 'memory', content: KILN },
  { store: 'memory', content: HARBOR },
  { store: 'memory', content: EXTRA },
  ...fixtureEntries.slice(3),
]
const offerShown = () =>
  Boolean(screen.queryByText('An unsaved draft for this is kept on this device:'))

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

// ---- review e395d03 probes ----------------------------------------------------------
const C_NOTE = 'Clay order note (fictional).'
const D_NOTE = 'Drying rack note (fictional).'
const D_D = 'Drying rack draft: the rack moved to the east wall (fictional).'
const FRESH1 = 'Harbor fresh draft one: the offsite moves to Thursday (fictional).'
const FRESH2 = 'Harbor fresh draft two: the offsite moves to Saturday (fictional).'
/** What a browser does when the focused control becomes disabled (Chromium: at its next frame). */
const browserFixup = () => {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body || !el.matches(':disabled')) return
  // jsdom's blur() ignores a disabled element; focus a stray button outside the editor and drop it.
  const away = document.createElement('button')
  document.body.append(away)
  away.focus()
  away.remove()
}
const changesPre = () => screen.queryByLabelText('Changes')

describe('Q1: focus around the memory editor, outside DocumentEditor (web.md: "Focus never drops to the page because of a change in an editor")', () => {
  it('Q1a: Delete entry… opens its confirmation, and Keep it closes it', async () => {
    harness()
    await open(/The kiln firing log/)
    button('Delete entry…')!.focus()
    fireEvent.click(button('Delete entry…')!)
    await settle()
    const afterOpen = focusName()
    button('Keep it')!.focus()
    fireEvent.click(button('Keep it')!)
    await settle()
    const afterKeep = focusName()
    expect(afterOpen).not.toBe('BODY')
    expect(afterKeep).not.toBe('BODY')
  })

  it('Q1b: the entry error row: Reload, and the read then succeeds', async () => {
    const h = harness()
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    await open(/The kiln firing log/)
    expect(screen.queryByText('Hermes is not answering.')).not.toBeNull()
    button('Reload')!.focus()
    fireEvent.click(button('Reload')!)
    await settle()
    await settle()
    const seen = { edit: Boolean(button('Edit')), focus: focusName() }
    expect(seen.edit).toBe(true)
    expect(seen.focus).not.toBe('BODY')
  })
})

describe('Q2: a focused control the change disables, with the blur Chromium does at its next frame', () => {
  async function confirmHeld(h: H, failure?: CindlError) {
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.hold('memory.write')
    if (failure) h.failNext('memory.write', failure)
    const confirm = button('Confirm and save')!
    confirm.focus()
    fireEvent.click(confirm)
    await settle()
    const disabled = button('Saving…')?.disabled ?? null
    browserFixup()
    h.release('memory.write')
    await settle()
    await settle()
    return disabled
  }

  it('Q2a: a save Hermes refuses (unavailable)', async () => {
    const h = harness()
    const disabled = await confirmHeld(
      h,
      new CindlError('unavailable', 'Hermes is not answering.'),
    )
    const seen = {
      disabled,
      error: alerts().some((a) => /Nothing was saved/.test(a)),
      focus: focusName(),
    }
    expect(seen.error).toBe(true)
    expect(seen.focus).not.toBe('BODY')
  })

  it('Q2b (F8): a save Hermes refuses as stale: focus lands on the changes', async () => {
    const h = harness()
    await confirmHeld(h, new CindlError('conflict', 'Probe conflict.'))
    const seen = {
      conflict: Boolean(button('Reload and keep my draft')),
      focus: focusName(),
    }
    expect(seen.conflict).toBe(true)
    expect(document.activeElement).toBe(changesPre())
  })

  it('Q2c: an adoption read Hermes refuses (unavailable)', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.hold('memory.read')
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    const adopt = button('Use this draft for the entry now here')!
    adopt.focus()
    fireEvent.click(adopt)
    await settle()
    browserFixup()
    h.release('memory.read')
    await settle()
    await settle()
    const seen = {
      refused: Boolean(
        screen.queryByText('Your draft was not used, and it is still kept.'),
      ),
      focus: focusName(),
    }
    expect(seen.refused).toBe(true)
    expect(seen.focus).not.toBe('BODY')
  })

  it('Q2d: P5e with the read answered after a frame: the refusal fetches the list and the button goes', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.mem.remove(/Harbor Loft/)
    h.holdAnswer('memory.read')
    const adopt = button('Use this draft for the entry now here')!
    adopt.focus()
    fireEvent.click(adopt)
    await settle()
    browserFixup()
    h.release('memory.read')
    for (let i = 0; i < 4; i++) await settle()
    const seen = {
      adoptStill: Boolean(button('Use this draft for the entry now here')),
      focus: focusName(),
    }
    expect(seen.adoptStill).toBe(false)
    expect(seen.focus).not.toBe('BODY')
  })

  it('Q2e: a lock lands while focus is on Review changes and the draft is already filed (adopted)', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.hold('memory.entries')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    button('Review changes')!.focus()
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Tuesday.',
    )
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    const atLock = focusName()
    browserFixup()
    await settle()
    const seen = { atLock, focus: focusName() }
    expect(seen.focus).not.toBe('BODY')
  })
})

describe('Q3: "Focus you moved elsewhere stays there" when the owner clicks plain page text (activeElement is the body)', () => {
  it('Q3a: a save lands after the owner clicked away', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.hold('memory.write')
    button('Confirm and save')!.focus()
    fireEvent.click(button('Confirm and save')!)
    await settle()
    ;(document.activeElement as HTMLElement).blur() // a click on plain text
    h.release('memory.write')
    await settle()
    await settle()
    const seen = {
      saved: Boolean(button('Restore previous version')),
      focus: focusName(),
    }
    // Observation only: Cindl moves focus back into the editor.
    expect(seen.saved).toBe(true)
  })

  it('Q3b: a lock lands after the owner clicked away', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    textarea()!.focus()
    textarea()!.blur() // a click on plain text
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    const seen = { locked: lockedNow(), focus: focusName() }
    expect(seen.locked).toBe(true)
  })
})

describe('Q4: keyed steps', () => {
  it('Q4a: the lock notice across a step change while locked', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    const before = screen.getByText(/cannot tell which/)
    button('Back to editing')!.focus()
    fireEvent.click(button('Back to editing')!)
    await settle()
    const after = screen.getByText(/cannot tell which/)
    const seen = {
      sameAlertElement: before === after,
      oldStillConnected: before.isConnected,
      focus: focusName(),
      box: textarea()?.value === D_K,
    }
    expect(seen.box).toBe(true)
  })

  it('Q4b: the textarea survives a lock landing in the edit step (same element, caret kept)', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    const box = textarea()!
    box.focus()
    box.setSelectionRange(5, 9)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    const seen = {
      same: textarea() === box,
      focus: document.activeElement === box,
      selection: [box.selectionStart, box.selectionEnd],
      readOnly: box.readOnly,
    }
    expect(seen.same).toBe(true)
    expect(seen.focus).toBe(true)
    expect(seen.selection).toEqual([5, 9])
  })

  it('Q4c: Restore previous version is offered again after restoring and discarding (state outlives the steps)', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    expect(button('Restore previous version')).not.toBeNull()
    fireEvent.click(button('Restore previous version')!)
    await settle()
    expect(textarea()?.value).toBe(KILN)
    fireEvent.click(button('Discard changes')!)
    await settle()
    const seen = {
      offered: Boolean(button('Restore previous version')),
      writes: h.writes().length,
    }
    expect(seen.offered).toBe(true)
    expect(seen.writes).toBe(1)
  })
})

describe('Q5: names', () => {
  it('Q5a: entries whose title and preview have no words', async () => {
    const h = harness([
      { store: 'memory', content: GLAZE },
      { store: 'memory', content: KILN },
      { store: 'memory', content: '#' },
      { store: 'memory', content: '#\n##' },
      ...fixtureEntries.slice(3),
    ])
    await settle()
    const names = screen
      .queryAllByRole('button', { name: /^Open memory entry: / })
      .map((b) => b.getAttribute('aria-label'))
    // The kiln note's editor locks onto the first of them.
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(new Set(names).size).toBe(names.length)
  })

  it('Q5b: discard names for drafts whose first lines differ only after 80 characters', async () => {
    const LONG =
      'Van keys: the studio van keys hang on the hook by the kiln room door, next to the glaze shelf'
    const h = harness()
    await open(/Glaze supplier/)
    await holdListAndReload(h)
    editTo('Edit agent note 1', `${LONG} (A).`)
    h.mem.remove(/Glaze supplier/)
    await releaseList(h)
    fireEvent.click(button(/Close/)!)
    await settle()
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', `${LONG} (B).`)
    h.mem.remove(/Harbor Loft/)
    await releaseList(h)
    fireEvent.click(button(/Close/)!)
    await settle()
    const names = screen
      .queryAllByRole('button', { name: /^Discard draft/ })
      .map((b) => b.getAttribute('aria-label'))
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
  })

  it('Q5c: "Written for" names the place now, and says nothing when two entries share the text', async () => {
    const h = harness(five())
    await harborOwnDraftOffered(h)
    // Fresh text, refused as stale: filed beside Harbor's own draft.
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: FRESH1 } })
    fireEvent.click(button('Review changes')!)
    h.failNext('memory.write', new CindlError('conflict', 'Probe conflict.'))
    fireEvent.click(button('Confirm and save')!)
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const first = screen.queryByText(/^Written for /)?.textContent ?? null
    // Bench is removed elsewhere; the list is fetched through another entry's editor.
    await open(/Extra note/)
    h.mem.remove(/Bench note/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    await settle()
    fireEvent.click(button(/^Close/)!)
    await settle()
    const moved = screen.queryByText(/^Written for /)?.textContent ?? null
    // A second entry with Harbor's text appears: the place is ambiguous.
    h.mem.add('memory', HARBOR)
    await open(/Extra note/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const twins = screen.queryByText(/^Written for /)?.textContent ?? null
    expect(first).toBe('Written for agent note 2.')
    expect(moved).toBe('Written for agent note 1.')
    expect(twins).toBeNull()
  })
})

describe('Q6: the three surviving mutations', () => {
  it('Q6a (q02): a second fresh draft filed beside an entry that already has one beside it gets its own slot', async () => {
    const h = harness([
      { store: 'memory', content: A_NOTE },
      { store: 'memory', content: B_NOTE },
      { store: 'memory', content: C_NOTE },
      { store: 'memory', content: D_NOTE },
      { store: 'memory', content: KILN },
      { store: 'memory', content: HARBOR },
      { store: 'memory', content: EXTRA },
      ...fixtureEntries.slice(3),
    ])
    // Round 1: Harbor's own draft (lock), a kiln draft used for Harbor and discarded, then fresh text.
    await open(/Harbor Loft/)
    await holdListAndReload(h)
    editTo('Edit agent note 6', D_H)
    h.mem.remove(/Archive shelf/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 4', D_K)
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(offerShown()).toBe(true)
    await holdListAndReload(h)
    editTo('Edit agent note 4', FRESH1)
    h.mem.remove(/Bench note/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const afterRound1 = keptKeys().map((k) => k.replace(/^.*:/, ''))
    // Round 2: the drying-rack draft used for Harbor and discarded, then more fresh text.
    await open(/Drying rack note/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_D)
    h.mem.remove(/Drying rack note/)
    await releaseList(h)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(offerShown()).toBe(true)
    await holdListAndReload(h)
    editTo('Edit agent note 2', FRESH2)
    h.mem.remove(/Clay order/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const seen = {
      afterRound1,
      keys: keptKeys().map((k) => k.replace(/^.*:/, '')),
      drafts: keptMemoryDrafts(),
      unsaved: screen
        .queryAllByText(/^Harbor fresh draft/)
        .map((p) => p.textContent?.slice(0, 26)),
    }
    expect(seen.drafts).toEqual([D_H, FRESH1, FRESH2])
  })

  it('Q6b (N19): a failed read, then Reload: its read fails too but the list moves the id, so the entry is read again', async () => {
    const h = harness()
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    await open(/Prefers a short morning brief/)
    expect(screen.queryByText('Hermes is not answering.')).not.toBeNull()
    // Elsewhere an agent note is removed: the note about you keeps its place under a new id.
    h.mem.remove(/Glaze supplier/)
    h.failNext('memory.read', new CindlError('unavailable', 'Hermes is not answering.'))
    fireEvent.click(button('Reload')!)
    for (let i = 0; i < 4; i++) await settle()
    const seen = {
      reads: h.reads(),
      edit: Boolean(button('Edit')),
      error: Boolean(screen.queryByText('Hermes is not answering.')),
    }
    expect(seen.edit).toBe(true)
    expect(seen.error).toBe(false)
  })
})

// Re-check e395d03: what Q3a, Q3b and Q4a observed, asserted, and its other
// notes (numbering among more drafts, focus around a delete).
describe('focus the owner moved away, the lock notice, numbering, delete', () => {
  it('R29: a save that lands after the owner clicked plain page text leaves focus there', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.hold('memory.write')
    button('Confirm and save')!.focus()
    fireEvent.click(button('Confirm and save')!)
    await settle()
    ;(document.activeElement as HTMLElement).blur() // a click on plain text
    h.release('memory.write')
    await settle()
    await settle()
    expect(button('Restore previous version')).not.toBeNull()
    expect(focusName()).toBe('BODY')
  })

  it('R29b: an adoption that lands after the owner clicked plain page text leaves focus there', async () => {
    const h = harness()
    await lockedByMerge(h)
    h.hold('memory.read')
    button('Use this draft for the entry now here')!.focus()
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    ;(document.activeElement as HTMLElement).blur() // a click on plain text
    h.release('memory.read')
    await settle()
    await settle()
    expect(lockedNow()).toBe(false)
    expect(focusName()).toBe('BODY')
  })

  it('R29c: a lock that lands after the owner clicked plain page text leaves focus there', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    textarea()!.focus()
    textarea()!.blur() // a click on plain text
    h.mem.remove(/kiln firing log/)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    expect(focusName()).toBe('BODY')
  })

  it('R30: while locked, a step change keeps the same lock notice, so it is not announced again', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    await holdListAndReload(h)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(/Harbor Loft/, HARBOR_MON)
    await releaseList(h)
    expect(lockedNow()).toBe(true)
    const before = screen.getByText(/cannot tell which/)
    fireEvent.click(button('Back to editing')!)
    await settle()
    expect(screen.getByText(/cannot tell which/)).toBe(before)
    expect(textarea()?.value).toBe(D_K)
  })

  it('R31: only drafts that share a first line are numbered, among themselves', async () => {
    const SHARED_A = 'Shared first line (fictional).\nDetail one.'
    const SHARED_B = 'Shared first line (fictional).\nDetail two.'
    const OTHER = 'Another draft (fictional).'
    const h = harness()
    const steps: Array<[RegExp, string]> = [
      [/Glaze supplier/, SHARED_A],
      [/The kiln firing log/, OTHER],
      [/Harbor Loft/, SHARED_B],
    ]
    for (const [entry, text] of steps) {
      await open(entry)
      await holdListAndReload(h)
      editTo('Edit agent note 1', text)
      h.mem.remove(entry)
      await releaseList(h)
      fireEvent.click(button(/Close/)!)
      await settle()
    }
    const names = screen
      .queryAllByRole('button', { name: /^Discard draft/ })
      .map((b) => b.getAttribute('aria-label'))
    expect(keptMemoryDrafts()).toEqual([SHARED_A, OTHER, SHARED_B])
    expect(names).toEqual([
      'Discard draft 1 of 2: Shared first line (fictional).',
      'Discard draft: Another draft (fictional).',
      'Discard draft 2 of 2: Shared first line (fictional).',
    ])
  })

  it('R32: a delete moves focus to Keep it, back to Delete entry…, to the confirmation while Hermes answers and after a refusal, and to the Entries heading once the entry is gone', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    fireEvent.click(button('Delete entry…')!)
    await settle()
    expect(document.activeElement).toBe(button('Keep it'))
    fireEvent.click(button('Keep it')!)
    await settle()
    expect(document.activeElement).toBe(button('Delete entry…'))
    fireEvent.click(button('Delete entry…')!)
    await settle()
    h.state.refuseDeletes = true
    fireEvent.click(button('Delete permanently')!)
    await settle()
    const group = screen.getByRole('group', { name: 'Delete this memory entry' })
    expect(document.activeElement).toBe(group)
    expect(alerts().join(' ')).toMatch(/Probe refused the delete/)
    h.state.refuseDeletes = false
    fireEvent.click(button('Delete permanently')!)
    await settle()
    await settle()
    expect(h.mem.has(/kiln firing log/)).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Entries' }))
  })
})

describe('a refused save after its draft is discarded', () => {
  it('R33: discarding a draft that Hermes refused as stale clears that refusal; a fresh edit can be reviewed and sent, and Hermes refuses it if the entry is still stale', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', D_K)
    fireEvent.click(button('Review changes')!)
    h.failNext('memory.write', new CindlError('conflict', 'Probe conflict.'))
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(alerts().join(' ')).toMatch(/Probe conflict\. Your draft is kept\./)
    fireEvent.click(button('Back to editing')!)
    fireEvent.click(button('Discard changes')!)
    await settle()
    expect(keptMemoryDrafts()).toEqual([])
    editTo('Edit agent note 2', `${D_K} Again.`)
    fireEvent.click(button('Review changes')!)
    expect(alerts().join(' ')).not.toMatch(/Your draft is kept/)
    expect(button('Confirm and save')?.disabled).toBe(false)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    await settle()
    expect(h.writes().map((w) => w.content)).toEqual([D_K, `${D_K} Again.`])
  })
})

describe('focus outside the editor', () => {
  it("R34: a list change that removes another row's focused Open button leaves the open editor alone; it takes no focus it never had", async () => {
    const h = harness()
    await open(/The kiln firing log/)
    screen.getByRole('button', { name: /Open memory entry: Harbor Loft/ }).focus()
    h.mem.remove(/Harbor Loft/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    await settle()
    expect(
      screen.queryByRole('button', { name: /Open memory entry: Harbor Loft/ }),
    ).toBeNull()
    expect(lockedNow()).toBe(false)
    expect(focusName()).toBe('BODY')
  })
})
