/** @vitest-environment jsdom */
import type { CindlClientApi, CindlEvent, LinkState } from '@cindl/contracts'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/shell/AppShell.tsx'
import { keepPlace, placeOf } from '../src/talk/places.ts'
import { keptDrafts } from '../src/views/drafts.ts'
import { Providers } from './memoryScreen.tsx'

// The shipped AppShell forgets what was typed when the session ends (its
// useSessionDrafts call; item 1 of run 20, note 3 of the ea69dc1 review):
// tested here on the shell itself, not on a copy of the hook's wiring.
// memoryScreen.tsx's hooks clean up after each test.

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  keptDrafts.clear()
})

/** A client whose link the test moves, answering no calls. */
function client() {
  const listeners = new Set<(event: CindlEvent) => void>()
  const api = {
    call: () => Promise.reject(new Error('no calls here')),
    subscribe: (listener: (event: CindlEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as CindlClientApi
  const link = (phase: LinkState['phase']) =>
    act(async () => {
      const event = {
        type: 'link.changed',
        link: { phase, since: '2026-11-04T09:00:00.000Z', connectionEpoch: 1 },
      } as unknown as CindlEvent
      for (const listener of [...listeners]) listener(event)
      await vi.advanceTimersByTimeAsync(100)
    })
  return { api, link }
}

describe('the app shell when the session ends', () => {
  it("forgets every kept draft and every conversation's place once Hermes refuses the session, and none before", async () => {
    const c = client()
    render(
      <Providers api={c.api}>
        <AppShell />
      </Providers>,
    )
    await c.link('online')
    keptDrafts.set('SOUL.md', 'A draft of the voice, not saved.')
    keepPlace('demo-main', {
      draft: 'Unsent (fixture)',
      toolId: 'tool-calendar',
      tool: 'computer',
    })
    await c.link('reconnecting')
    expect(keptDrafts.has('SOUL.md')).toBe(true)
    expect(placeOf('demo-main').tool).toBe('computer')
    await c.link('signed-out')
    expect(keptDrafts.size).toBe(0)
    expect(placeOf('demo-main')).toEqual({
      draft: '',
      scrollY: undefined,
      toolId: undefined,
      tool: undefined,
    })
  })
})
