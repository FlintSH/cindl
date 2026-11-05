// Where the owner left each conversation (talk/places.ts): the unsent message
// and the selected step stay with their own conversation across conversation
// and view switches, and go when the session ends. Synthetic scenario only.
import { CindlProvider } from '@cindl/client-react'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/shell/AppShell.tsx'
import { forgetPlaces } from '../src/talk/places.ts'

beforeEach(() => {
  // jsdom has no matchMedia: a wide window, where the margin is a column.
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === '(min-width: 1280px)',
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})

afterEach(() => {
  cleanup()
  forgetPlaces()
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })

const goTo = async (hash: string) => {
  window.location.hash = hash
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  await settle()
  await settle()
}

const box = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' })

async function renderShell(hash = '#/talk/demo-main') {
  window.history.replaceState(null, '', hash)
  const scenario = createScenarioClient({ speed: 0 })
  render(
    <CindlProvider api={scenario}>
      <AppShell />
    </CindlProvider>,
  )
  await settle()
  await settle()
  return scenario
}

/** Steps sit in a work log that folds once it is done: open it to reach them. */
const openSteps = () => {
  const head = screen.queryByRole('button', { name: /^2 steps/ })
  if (head?.getAttribute('aria-expanded') === 'false') fireEvent.click(head)
}

describe('where the owner left a conversation', () => {
  it('keeps an unsent message with its own conversation, never another', async () => {
    await renderShell()
    fireEvent.change(box(), { target: { value: 'Ask about the glaze order (fixture)' } })
    await goTo('#/talk/demo-inventory')
    expect(box().value).toBe('')
    fireEvent.change(box(), { target: { value: 'Recount the cones (fixture)' } })
    await goTo('#/talk/demo-main')
    expect(box().value).toBe('Ask about the glaze order (fixture)')
    await goTo('#/talk/demo-inventory')
    expect(box().value).toBe('Recount the cones (fixture)')
  })

  it('follows the main conversation when another one becomes main, without its draft', async () => {
    const scenario = await renderShell('#/talk')
    fireEvent.change(box(), { target: { value: 'For today only (fixture)' } })
    await act(() =>
      scenario.call('conversations.setMain', { conversationId: 'demo-inventory' }),
    )
    await settle()
    expect(box().value).toBe('')
    await act(() =>
      scenario.call('conversations.setMain', { conversationId: 'demo-main' }),
    )
    await settle()
    expect(box().value).toBe('For today only (fixture)')
  })

  it('keeps it while the owner is in another view', async () => {
    await renderShell()
    fireEvent.change(box(), { target: { value: 'Half a thought (fixture)' } })
    await goTo('#/work')
    expect(screen.queryByRole('textbox', { name: 'Message Hermes' })).toBeNull()
    await goTo('#/talk/demo-main')
    expect(box().value).toBe('Half a thought (fixture)')
  })

  it('keeps the selected step with its conversation while the owner is elsewhere', async () => {
    await renderShell()
    const step = () =>
      screen.getByRole('button', { name: /Checked the studio calendar for Thursday/ })
    openSteps()
    fireEvent.click(step())
    await settle()
    expect(step().getAttribute('aria-pressed')).toBe('true')
    await goTo('#/work')
    await goTo('#/talk/demo-inventory')
    await goTo('#/talk/demo-main')
    expect(step().getAttribute('aria-pressed')).toBe('true')
  })

  it('forgets every unsent message when the owner signs out', async () => {
    await renderShell()
    fireEvent.change(box(), { target: { value: 'Not for the next session (fixture)' } })
    await goTo('#/agent/device')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out on this device' }))
    await settle()
    expect(screen.getByText('Signed out on this device.')).toBeTruthy()
    await goTo('#/talk/demo-main')
    expect(box().value).toBe('')
  })
})
