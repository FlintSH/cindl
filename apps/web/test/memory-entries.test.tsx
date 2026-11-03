import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryView } from '../src/library/LibraryView.tsx'

afterEach(cleanup)

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
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
