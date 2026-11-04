import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi, CindlEvent } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/shell/AppShell.tsx'
import { forgetPlaces, keepPlace } from '../src/talk/places.ts'

const scrollTo = vi.fn()

beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === '(min-width: 1280px)',
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  // jsdom lays nothing out and has no element scrollTo.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  })
})

afterEach(() => {
  cleanup()
  forgetPlaces()
  vi.unstubAllGlobals()
  scrollTo.mockReset()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })

/** The synthetic scenario, with its link held at `reconnecting`: the message box is disabled. */
async function renderReconnecting() {
  window.history.replaceState(null, '', '#/talk/demo-main')
  const scenario = createScenarioClient({ speed: 0 })
  const api: CindlClientApi = {
    call: (name: never, args: never) => scenario.call(name, args),
    subscribe: (listener) =>
      scenario.subscribe((event: CindlEvent) =>
        listener(
          event.type === 'link.changed'
            ? { ...event, link: { ...event.link, phase: 'reconnecting' } }
            : event,
        ),
      ),
  }
  render(
    <CindlProvider api={api}>
      <AppShell />
    </CindlProvider>,
  )
  await settle()
  await settle()
}

describe('"Latest"', () => {
  it('hands focus to the switcher when the message box cannot take it', async () => {
    // The owner had scrolled up to read: "Latest" is shown.
    keepPlace('demo-main', { scrollTop: 120 })
    await renderReconnecting()
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Hermes' })
        .disabled,
    ).toBe(true)
    const latest = screen.getByRole('button', { name: /^Jump to latest messages/ })
    latest.focus()
    fireEvent.click(latest)
    await settle()
    expect(scrollTo).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Jump to latest messages/ })).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Switch conversation/ }),
    )
  })
})
