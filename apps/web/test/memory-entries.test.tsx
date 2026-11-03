import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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

/** The synthetic scenario, with every operation recorded. */
function recorded() {
  const scenario = createScenarioClient({ speed: 0 })
  const calls: Array<{ name: string; args: unknown }> = []
  const api: CindlClientApi = {
    call: (name, args) => {
      calls.push({ name, args })
      return scenario.call(name, args)
    },
    subscribe: (listener) => scenario.subscribe(listener),
  }
  return { api, calls }
}

describe('memory entries', () => {
  it('deletes only after a warning, by the current fingerprinted id, with confirmation', async () => {
    const { api, calls } = recorded()
    render(
      <CindlProvider api={api}>
        <LibraryView section="memory" />
      </CindlProvider>,
    )
    await settle()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open memory entry: The kiln firing log/,
      }),
    )
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete entry…' }))
    expect(
      screen.getByText(/Hermes keeps no backup, so this cannot be undone/),
    ).toBeTruthy()
    expect(calls.some((call) => call.name === 'memory.delete')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    await settle()
    const deleted = calls.find((call) => call.name === 'memory.delete')
    expect(deleted?.args).toMatchObject({
      id: expect.stringMatching(/^memory:memory:1:[a-f0-9]{12}$/) as unknown,
      confirm: true,
    })
    await settle()
    expect(screen.queryByRole('button', { name: /The kiln firing log/ })).toBeNull()
  })

  // Review 91f30e07 N2: Hermes numbers entries across both stores, so the id's
  // index is not the entry's place in its store.
  it('names an entry by its place in its store, not by its Hermes index', async () => {
    const { api } = recorded()
    render(
      <CindlProvider api={api}>
        <LibraryView section="memory" />
      </CindlProvider>,
    )
    await settle()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open memory entry: Prefers a short morning brief/,
      }),
    )
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Edit note about you 1')).toBeTruthy()
  })

  it('keeps "Restore previous version" after a save gives the entry a new id', async () => {
    const { api, calls } = recorded()
    render(
      <CindlProvider api={api}>
        <LibraryView section="memory" />
      </CindlProvider>,
    )
    await settle()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open memory entry: The kiln firing log/,
      }),
    )
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit agent note 2'), {
      target: { value: 'The kiln firing log moved to the studio binder (fictional).' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save' }))
    await settle()
    await settle()
    expect(calls.some((call) => call.name === 'memory.write')).toBe(true)
    expect(
      await screen.findByRole('button', { name: 'Restore previous version' }),
    ).toBeTruthy()
  })
})

// Review 4ad97d1 SF1 and SF2 (probes A, B, B2, C): an entry changed or removed
// elsewhere while the owner edits must never receive a draft or a restore that
// was reviewed against another entry.
describe('memory entries changed elsewhere', () => {
  type Scenario = ReturnType<typeof createScenarioClient>
  const findEntry = async (scenario: Scenario, text: RegExp) => {
    const entries = await scenario.call('memory.entries', {})
    const found = entries.find((e) => text.test(e.preview))
    if (!found) throw new Error(`no entry matching ${String(text)}`)
    return found
  }
  /** A harness whose list reads can be held, and whose writes can trigger a change elsewhere. */
  function harness(
    options: { afterWrite?: ((scenario: Scenario) => Promise<void>) | undefined } = {},
  ) {
    const scenario = createScenarioClient({ speed: 0 })
    const calls: Array<{ name: string; args: unknown }> = []
    let holdNextList = false
    let release: (() => void) | undefined
    const api: CindlClientApi = {
      call: async (name, args) => {
        calls.push({ name, args })
        if (name === 'memory.entries' && holdNextList) {
          holdNextList = false
          await new Promise<void>((resolve) => (release = resolve))
        }
        const result = await scenario.call(name, args)
        if (name === 'memory.write' && options.afterWrite) {
          const hook = options.afterWrite
          options.afterWrite = undefined
          await hook(scenario)
        }
        return result
      },
      subscribe: (listener) => scenario.subscribe(listener),
    }
    render(
      <CindlProvider api={api}>
        <LibraryView section="memory" />
      </CindlProvider>,
    )
    return {
      scenario,
      calls,
      holdNextList: () => (holdNextList = true),
      release: () => release?.(),
    }
  }
  const openKiln = async () => {
    await settle()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open memory entry: The kiln firing log/,
      }),
    )
    await settle()
  }
  const editTo = (text: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit agent note 2'), {
      target: { value: text },
    })
  }
  const draft = 'The kiln firing log moved to the studio binder (fictional).'
  const harborStays = async (scenario: Scenario) =>
    expect(
      (await scenario.call('memory.entries', {})).some((e) =>
        /Harbor Loft/.test(e.preview),
      ),
    ).toBe(true)

  it('A: brings the editor back with the draft after "Reload and keep my draft"', async () => {
    const { scenario } = harness()
    await openKiln()
    editTo(draft)
    const kiln = await findEntry(scenario, /kiln firing log/)
    await scenario.call('memory.write', {
      id: kiln.id,
      content: 'The kiln log changed elsewhere (fictional).',
      confirm: true,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/changed since you read it/)
    fireEvent.click(screen.getByRole('button', { name: 'Reload and keep my draft' }))
    await settle()
    await settle()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Edit agent note 2').value).toBe(
      draft,
    )
    // The review is now against the text changed elsewhere.
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByLabelText('Changes').textContent).toContain('changed elsewhere')
  })

  it('B: drops the restore offer when another entry takes the place after a save', async () => {
    const { scenario, calls } = harness({
      // Between the save and the list reload, an earlier entry is removed elsewhere.
      afterWrite: async (s) => {
        const glaze = await findEntry(s, /Glaze supplier/)
        await s.call('memory.delete', { id: glaze.id, confirm: true })
      },
    })
    await openKiln()
    editTo(draft)
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save' }))
    await settle()
    await settle()
    expect(screen.queryByRole('button', { name: 'Restore previous version' })).toBeNull()
    expect(calls.filter((c) => c.name === 'memory.write')).toHaveLength(1)
    await harborStays(scenario)
  })

  it('B2: drops the restore offer when an earlier entry was removed while reading', async () => {
    const { scenario } = harness()
    await openKiln()
    const glaze = await findEntry(scenario, /Glaze supplier/)
    await scenario.call('memory.delete', { id: glaze.id, confirm: true })
    editTo(draft)
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save' }))
    await settle()
    await settle()
    // The place now shows Harbor Loft; the kiln note's old text is not offered over it.
    const shown = Array.from(document.querySelectorAll('pre')).map(
      (p) => p.textContent ?? '',
    )
    if (shown.some((t) => /Harbor Loft/.test(t)))
      expect(
        screen.queryByRole('button', { name: 'Restore previous version' }),
      ).toBeNull()
    await harborStays(scenario)
  })

  it('C: will not confirm a review whose entry was swapped while it was open', async () => {
    const { scenario, calls, holdNextList, release } = harness()
    await openKiln()
    holdNextList()
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    await settle()
    editTo(draft)
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    // An earlier entry is removed elsewhere, then the slow list arrives.
    const glaze = await findEntry(scenario, /Glaze supplier/)
    await scenario.call('memory.delete', { id: glaze.id, confirm: true })
    release()
    await settle()
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(
      /changed in Hermes while you were reviewing/,
    )
    const confirm = screen.getByRole('button', { name: 'Confirm and save' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirm)
    await settle()
    expect(calls.filter((c) => c.name === 'memory.write')).toHaveLength(0)
    await harborStays(scenario)
    // The draft survives for a fresh review.
    fireEvent.click(screen.getByRole('button', { name: 'Back to editing' }))
    expect(screen.getByLabelText<HTMLTextAreaElement>('Edit agent note 2').value).toBe(
      draft,
    )
  })

  it('closes an open delete confirmation when another entry takes the place', async () => {
    const { scenario, calls, holdNextList, release } = harness()
    await openKiln()
    holdNextList()
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Delete entry…' }))
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeTruthy()
    const glaze = await findEntry(scenario, /Glaze supplier/)
    await scenario.call('memory.delete', { id: glaze.id, confirm: true })
    release()
    await settle()
    await settle()
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()
    expect(calls.filter((c) => c.name === 'memory.delete')).toHaveLength(0)
    await harborStays(scenario)
  })
})
