// Re-check 5949d7f: the reviewer's probes of entry identity in the memory
// editor (and the shared document editor), kept as regressions. A draft, a
// save and a delete stay bound to the entry the owner read; text at a place
// that may be another entry locks the editor instead of being followed.
import { sha256Hex } from '@cindl/client-core'
import { CindlProvider } from '@cindl/client-react'
import { CindlError, type CindlClientApi } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentView } from '../src/agent/AgentView.tsx'
import { LibraryView } from '../src/library/LibraryView.tsx'
import { forgetDocumentDrafts } from '../src/views/DocumentEditor.tsx'

afterEach(() => {
  cleanup()
  forgetDocumentDrafts()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })

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

/** Memory shaped like the fixture and Hermes's learning routes, plus changes made elsewhere. */
function memoryBackend(initial: Array<{ store: Store; content: string }>) {
  const entries = initial.map((entry) => ({ ...entry }))
  const fp = (content: string) => sha256Hex(content.trim()).slice(0, 12)
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
    contents: () => ordered().map((e) => `${e.store}: ${e.content}`),
  }
}

function harness(initial = fixtureEntries) {
  const scenario = createScenarioClient({ speed: 0 })
  const mem = memoryBackend(initial)
  const calls: Array<{ name: string; args: unknown }> = []
  const state = {
    holdList: false,
    failRead: false,
    release: undefined as (() => void) | undefined,
  }
  const api: CindlClientApi = {
    call: (async (name: string, args: unknown) => {
      calls.push({ name, args })
      if (name === 'memory.read' && state.failRead) {
        state.failRead = false
        throw new CindlError('unavailable', 'Hermes is not answering.')
      }
      if (name === 'memory.entries' && state.holdList) {
        state.holdList = false
        await new Promise<void>((resolve) => (state.release = resolve))
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
    mem,
    calls,
    writes: () => calls.filter((c) => c.name === 'memory.write').map((c) => c.args),
    deletes: () => calls.filter((c) => c.name === 'memory.delete').map((c) => c.args),
    holdNextList: () => (state.holdList = true),
    failNextRead: () => (state.failRead = true),
    release: () => state.release?.(),
    // Leave the page and come back under the same provider (the scenario emits
    // its link and capabilities once).
    remount: () => {
      view.rerender(<CindlProvider api={api}>{null}</CindlProvider>)
      view.rerender(ui())
    },
  }
}

const draft = 'The kiln firing log moved to the studio binder (fictional).'
const open = async (title: RegExp) => {
  await settle()
  fireEvent.click(
    await screen.findByRole('button', {
      name: new RegExp(`Open memory entry: ${title.source}`),
    }),
  )
  await settle()
}
const editTo = (label: string, text: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } })
}
const button = (name: string | RegExp) =>
  screen.queryByRole<HTMLButtonElement>('button', { name })
/** What the owner sees, and what one more Review + Confirm would send. */
async function tryToSave(_tag: string, _h: ReturnType<typeof harness>) {
  const box = screen.queryByLabelText<HTMLTextAreaElement>(
    /^Edit (agent note|note about you) \d$/,
  )
  const seen = {
    alert: screen.queryAllByRole('alert').map((a) => a.textContent?.slice(0, 70)),
    keptNotice: Boolean(screen.queryByText(/Your unsaved draft was kept/)),
    box: box ? { value: box.value.slice(0, 50), readOnly: box.readOnly } : null,
    reviewEnabled: button('Review changes')?.disabled === false,
  }
  if (seen.reviewEnabled) {
    fireEvent.click(button('Review changes')!)
    const confirm = button('Confirm and save')
    if (confirm && !confirm.disabled) {
      fireEvent.click(confirm)
      await settle()
      await settle()
    }
  }
  return seen
}

describe('re-check of f7f5925 P3/P4 with the flow the fix allows', () => {
  it('P3a: after the reviewed entry is removed, "Reload and keep my draft" locks and offers nothing as kept', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', draft)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    const seen = await tryToSave('P3a', h)
    expect(seen.alert.join(' ')).toMatch(/removed or moved in Hermes/)
    expect(seen.keptNotice).toBe(false)
    expect(seen.reviewEnabled).toBe(false)
    expect(h.writes()).toHaveLength(1)
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('P4a: another entry taking the place during editing raises a notice and blocks review', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit agent note 2', draft)
    h.mem.remove(/Glaze supplier/)
    h.release()
    await settle()
    await settle()
    const seen = await tryToSave('P4a', h)
    expect(seen.alert.join(' ')).toMatch(/removed or moved in Hermes/)
    expect(seen.reviewEnabled).toBe(false)
    expect(h.writes()).toHaveLength(0)
  })
})

describe('remaining paths to the wrong entry or a lost draft', () => {
  it('N1: after the lock, closing and reopening the place does not offer the kept draft over the entry now there', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', draft)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/removed or moved in Hermes/)
    // The lock notice says: close this and open the entry again.
    fireEvent.click(button(/Close memory entry: Harbor Loft/)!)
    await settle()
    fireEvent.click(button(/Open memory entry: Harbor Loft/)!)
    await settle()
    await settle()
    const seen = await tryToSave('N1', h)
    expect(seen.keptNotice).toBe(false)
    // The only write is the refused first attempt, to the kiln note's own id
    // (it shares the "memory:memory:1:" prefix with Harbor Loft's renumbered
    // id, so compare fingerprints): nothing was written to Harbor Loft.
    const harbor = sha256Hex(
      'Harbor Loft (fictional) holds the offsite date until Friday.',
    ).slice(0, 12)
    expect(h.writes()).toHaveLength(1)
    expect(h.writes().some((w) => (w as { id: string }).id.endsWith(`:${harbor}`))).toBe(
      false,
    )
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('N1b: a draft kept after a conflict is not offered over the entry that later holds its place (close, leave, come back)', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', draft)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    // The owner closes the conflicted entry and leaves the page.
    fireEvent.click(button(/Close memory entry: The kiln firing log/)!)
    h.remount()
    await open(/Harbor Loft/)
    await settle()
    const seen = await tryToSave('N1b', h)
    expect(seen.keptNotice).toBe(false)
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })

  // N1d, as probed, reopens the place and deletes. The kept kiln draft no
  // longer follows the place, so the reopened editor shows Harbor Loft's own
  // text and the confirmation names it: deleting it is then the owner's
  // explicit choice, not authority carried over from the kiln draft. The
  // locked editor itself offers no delete, and the kiln draft is kept.
  it('N1d: after the lock, nothing is deleted from the locked editor, and the reopened place shows its own entry', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', draft)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    // Locked: no delete is offered for the entry now at the place.
    expect(button('Delete entry…')).toBeNull()
    fireEvent.click(button(/Close memory entry: Harbor Loft/)!)
    await settle()
    // Closed, the kiln draft is listed for copying, not attached to Harbor Loft.
    expect(screen.getByText('Unsaved drafts')).toBeTruthy()
    expect(screen.getByText(draft)).toBeTruthy()
    fireEvent.click(button(/Open memory entry: Harbor Loft/)!)
    await settle()
    await settle()
    expect(screen.queryByLabelText<HTMLTextAreaElement>('Edit agent note 2')).toBeNull()
    expect(
      screen.getAllByText(/Harbor Loft \(fictional\) holds the offsite date/).length,
    ).toBeGreaterThan(0)
    fireEvent.click(button('Delete entry…')!)
    expect(
      screen.getByRole('group', { name: 'Delete this memory entry' }).textContent,
    ).toMatch(/Delete “Harbor Loft/)
    fireEvent.click(button('Keep it')!)
    expect(h.deletes()).toHaveLength(0)
    expect(h.mem.has(/Harbor Loft/)).toBe(true)
  })

  it('N2: an entry removed while the next one is rewritten (a merge) locks instead of following the rewritten neighbour', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit agent note 2', draft)
    // Elsewhere, the agent merges the kiln note into the Harbor note.
    h.mem.remove(/kiln firing log/)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    h.release()
    await settle()
    await settle()
    const seen = await tryToSave('N2', h)
    expect(seen.alert.join(' ')).toMatch(/removed or moved in Hermes/)
    expect(h.mem.has(/until Monday/)).toBe(true)
  })

  it('N2c: the same merge during review, then "Reload and keep my draft"', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', draft)
    fireEvent.click(button('Review changes')!)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    fireEvent.click(button('Confirm and save')!)
    await settle()
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    const seen = await tryToSave('N2c', h)
    expect(seen.keptNotice && seen.reviewEnabled).toBe(false)
    expect(h.mem.has(/until Monday/)).toBe(true)
  })

  it('N2d: after the merge, "Delete entry…" from the kiln draft does not delete the rewritten neighbour', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit agent note 2', draft)
    h.mem.remove(/kiln firing log/)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    h.release()
    await settle()
    await settle()
    const del = button('Delete entry…')
    if (del) {
      fireEvent.click(del)
      fireEvent.click(button('Delete permanently')!)
      await settle()
    }
    expect(h.mem.has(/until Monday/)).toBe(true)
  })

  it('N3: the last entry removed and a new one added in its place does not receive the old draft silently', async () => {
    const h = harness()
    await open(/Harbor Loft/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo(
      'Edit agent note 3',
      'Harbor Loft (fictional) holds the offsite date until Tuesday.',
    )
    h.mem.remove(/Harbor Loft/)
    h.mem.add('memory', 'Bisque firings moved to the small kiln (fictional).')
    h.release()
    await settle()
    await settle()
    const seen = await tryToSave('N3', h)
    expect(seen.alert.length).toBeGreaterThan(0)
    expect(h.mem.has(/Bisque firings/)).toBe(true)
  })

  it('N4: the only entry of a store removed during editing keeps its row and draft', async () => {
    const h = harness(fixtureEntries.filter((e) => !/morning brief/.test(e.content)))
    await open(/Protects focus time/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit note about you 1', 'My unsaved note (fictional).')
    h.mem.remove(/Protects focus time/)
    h.release()
    await settle()
    await settle()
    const box = screen.queryByLabelText<HTMLTextAreaElement>('Edit note about you 1')
    expect(box?.value).toBe('My unsaved note (fictional).')
  })

  it('N4b: the last entry in Hermes removed during editing keeps its row and draft', async () => {
    const h = harness([{ store: 'memory', content: 'Only note (fictional).' }])
    await open(/Only note/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit agent note 1', 'Only note, edited (fictional).')
    h.mem.remove(/Only note/)
    h.release()
    await settle()
    await settle()
    const box = screen.queryByLabelText<HTMLTextAreaElement>('Edit agent note 1')
    expect(box?.value).toBe('Only note, edited (fictional).')
  })

  it('N8: a renumbered entry is followed even when its read fails, and Reload then reads the new id', async () => {
    const h = harness()
    await open(/Prefers a short morning brief/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit note about you 1', 'Prefers a short morning brief, ready before 08:15.')
    h.mem.remove(/Glaze supplier/)
    h.failNextRead()
    h.release()
    await settle()
    await settle()
    const box = screen.queryByLabelText<HTMLTextAreaElement>('Edit note about you 1')
    expect(box?.value).toBe('Prefers a short morning brief, ready before 08:15.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    await settle()
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(h.mem.has(/08:15/)).toBe(true)
    expect(h.mem.has(/Harbor Loft/) && h.mem.has(/kiln firing log/)).toBe(true)
  })
})

describe('restore after a save', () => {
  it('N9: when another entry takes the place right after a save, the previous text is still on screen', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    editTo('Edit agent note 2', draft)
    fireEvent.click(button('Review changes')!)
    h.holdNextList()
    fireEvent.click(button('Confirm and save')!)
    await settle()
    h.mem.remove(/Glaze supplier/)
    h.release()
    await settle()
    await settle()
    const previous = 'The kiln firing log lives in the studio inventory sheet'
    expect(document.body.textContent).toContain(previous)
  })
})

describe('explicit re-selection', () => {
  it('uses a locked draft for the entry now here only when the owner chooses it', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit agent note 2', draft)
    // A merge elsewhere: the kiln note is removed and Harbor Loft rewritten.
    h.mem.remove(/kiln firing log/)
    h.mem.replace(
      /Harbor Loft/,
      'Harbor Loft (fictional) holds the offsite date until Monday.',
    )
    h.release()
    await settle()
    await settle()
    expect(button('Review changes')?.disabled).toBe(true)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    // Now the review compares the draft with the rewritten entry, in full view.
    fireEvent.click(button('Review changes')!)
    expect(screen.getByLabelText('Changes').textContent).toContain('until Monday')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    expect(h.writes()).toHaveLength(1)
    expect(h.mem.has(/studio binder/)).toBe(true)
  })

  it('discards a kept draft from the list only when asked', async () => {
    const h = harness()
    await open(/The kiln firing log/)
    h.holdNextList()
    fireEvent.click(button('Reload')!)
    await settle()
    editTo('Edit agent note 2', draft)
    h.mem.remove(/kiln firing log/)
    h.release()
    await settle()
    await settle()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    expect(screen.getByText(draft)).toBeTruthy()
    h.remount()
    await settle()
    expect(screen.getByText(draft)).toBeTruthy()
    fireEvent.click(button(/^Discard draft/)!)
    await settle()
    expect(screen.queryByText(draft)).toBeNull()
    expect(h.writes()).toHaveLength(0)
  })
})

describe('SOUL and skills share DocumentEditor', () => {
  it('S1: a failed SOUL re-read after a conflict keeps the draft, and a save against the stale text is refused', async () => {
    const scenario = createScenarioClient({ speed: 0 })
    const calls: Array<{ name: string; args: unknown }> = []
    let failSoulRead = false
    const api: CindlClientApi = {
      call: async (name: string, args: unknown) => {
        calls.push({ name, args })
        if (name === 'soul.read' && failSoulRead) {
          failSoulRead = false
          throw new CindlError('unavailable', 'Hermes is not answering.')
        }
        return scenario.call(name as never, args as never)
      },
      subscribe: (listener) => scenario.subscribe(listener),
    }
    render(
      <CindlProvider api={api}>
        <AgentView section="identity" />
      </CindlProvider>,
    )
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText<HTMLTextAreaElement>(/^Edit soul/)
    fireEvent.change(box, { target: { value: `${box.value}\nA new line (fictional).` } })
    fireEvent.click(button('Review changes')!)
    const current = (await scenario.call('soul.read', {})) as {
      content: string
      version: string
    }
    await scenario.call('soul.write', {
      content: `${current.content}\nChanged elsewhere (fictional).`,
      expectedVersion: current.version,
      confirm: true,
    } as never)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    failSoulRead = true
    fireEvent.click(button('Reload and keep my draft')!)
    await settle()
    await settle()
    const kept = screen.queryByLabelText<HTMLTextAreaElement>(/^Edit soul/)
    const seen = {
      error: Boolean(screen.queryByText('Hermes is not answering.')),
      kept: kept?.value.includes('A new line') ?? false,
    }
    if (button('Review changes')?.disabled === false) {
      fireEvent.click(button('Review changes')!)
      const confirm = button('Confirm and save')
      if (confirm && !confirm.disabled) fireEvent.click(confirm)
      await settle()
    }
    const final = (await scenario.call('soul.read', {})) as { content: string }
    expect(seen.kept).toBe(true)
    expect(final.content).toContain('Changed elsewhere')
  })

  it('S2: a skill save finishing after the owner moved to another skill keeps the second skill and its draft', async () => {
    const scenario = createScenarioClient({ speed: 0 })
    let releaseWrite: (() => void) | undefined
    const api: CindlClientApi = {
      call: async (name: string, args: unknown) => {
        if (
          name === 'skills.write' &&
          (args as { name: string }).name === 'calendar-triage'
        )
          await new Promise<void>((resolve) => (releaseWrite = resolve))
        return scenario.call(name as never, args as never)
      },
      subscribe: (listener) => scenario.subscribe(listener),
    }
    const ui = (item: string) => (
      <CindlProvider api={api}>
        <LibraryView section="skills" item={item} />
      </CindlProvider>
    )
    const view = render(ui('calendar-triage'))
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const a = screen.getByLabelText<HTMLTextAreaElement>('Edit skill:calendar-triage')
    fireEvent.change(a, { target: { value: `${a.value}\nOne more step (fictional).` } })
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await settle()
    // While the save is in flight the owner opens another skill and starts editing it.
    view.rerender(ui('inventory-sheets'))
    await settle()
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const b = screen.getByLabelText<HTMLTextAreaElement>('Edit skill:inventory-sheets')
    fireEvent.change(b, {
      target: { value: 'Draft for the inventory skill (fictional).' },
    })
    releaseWrite?.()
    await settle()
    await settle()
    const after = screen.queryByLabelText<HTMLTextAreaElement>(
      'Edit skill:inventory-sheets',
    )
    expect(after?.value).toBe('Draft for the inventory skill (fictional).')
  })
})
