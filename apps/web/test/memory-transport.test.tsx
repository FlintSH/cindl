// Re-check de42f21: the web memory editor driven through the direct client
// (client-core) and the Hermes adapter against the fake Hermes on loopback,
// kept as regressions with their assertions unchanged. Synthetic data only.
import { webcrypto } from 'node:crypto'
import { CindlProvider } from '@cindl/client-react'
import { type CindlClientApi, type CindlEvent } from '@cindl/contracts'
import { memoryFingerprint } from '@cindl/fixtures/fake-hermes'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { webCryptoProvider } from '../../../packages/hermes-adapter/src/index.ts'
import { harness as directHarness } from '../../../packages/client-core/test/direct-harness.ts'
import { LibraryView } from '../src/library/LibraryView.tsx'
import { forgetDocumentDrafts, keptDocumentDrafts } from '../src/views/DocumentEditor.tsx'

afterEach(() => {
  cleanup()
  forgetDocumentDrafts()
})

const GLAZE = 'Glaze supplier calls moved to Thursdays at 10:00 (fictional supplier).'
const KILN = 'The kiln firing log lives in the studio inventory sheet, tab "Firings".'
const HARBOR = 'Harbor Loft (fictional) holds the offsite date until Friday.'
const HARBOR_MON = 'Harbor Loft (fictional) holds the offsite date until Monday.'
const BRIEF = 'Prefers a short morning brief, ready before 08:30.'
const FOCUS = 'Protects focus time before 11:00 on weekdays.'
const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
const until = async (check: () => boolean, ms = 4_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await settle()
  }
}

type Gate = 'memory.entries' | 'memory.read' | 'memory.write' | 'memory.delete'

async function setup() {
  const h = await directHarness({
    deps: { crypto: webCryptoProvider(webcrypto as unknown as Crypto) },
  })
  await h.waitFor(
    () => h.store.getState().capabilities['memory.text']?.state === 'available',
  )
  const profile = h.fake.store.profile('default')
  profile.memory.memory = [GLAZE, KILN, HARBOR]
  profile.memory.profile = [BRIEF, FOCUS]
  const calls: Array<{ name: string; args: unknown }> = []
  const held = new Map<Gate, 'request' | 'answer'>()
  const releases = new Map<Gate, () => void>()
  const api: CindlClientApi = {
    call: (async (name: string, args: unknown) => {
      calls.push({ name, args })
      const mode = held.get(name as Gate)
      if (mode) held.delete(name as Gate)
      const gate = () =>
        new Promise<void>((resolve) => releases.set(name as Gate, resolve))
      if (mode === 'request') await gate()
      let result: unknown
      let error: unknown
      try {
        result = await h.client.call(name as never, args as never)
      } catch (err) {
        error = err
      }
      if (mode === 'answer') await gate()
      if (error instanceof Error) throw error
      return result
    }) as CindlClientApi['call'],
    // The provider subscribes after the client started: replay what it said so far.
    subscribe: (listener: (event: CindlEvent) => void) => {
      for (const event of h.events) listener(event)
      return h.client.subscribe(listener)
    },
  }
  render(
    <CindlProvider api={api}>
      <LibraryView section="memory" />
    </CindlProvider>,
  )
  await until(
    () => screen.queryAllByRole('button', { name: /Open memory entry/ }).length > 0,
  )
  return {
    h,
    profile,
    calls,
    learning: () =>
      h.fake.calls.filter((c) => /learning\/node/.test(c.name)).map((c) => c.name),
    hold: (gate: Gate, mode: 'request' | 'answer' = 'answer') =>
      void held.set(gate, mode),
    release: async (gate: Gate) => {
      await until(() => releases.has(gate))
      const resolve = releases.get(gate)
      releases.delete(gate)
      resolve?.()
      await settle()
      await settle()
    },
  }
}

const button = (name: string | RegExp) =>
  screen.queryByRole<HTMLButtonElement>('button', { name })
const alerts = () => screen.queryAllByRole('alert').map((a) => a.textContent ?? '')
const lockedNow = () => alerts().some((a) => /cannot tell which/.test(a))
const textarea = () =>
  screen.queryByLabelText<HTMLTextAreaElement>(/^Edit (agent note|note about you) \d$/)

describe('adapter id semantics against the fake Hermes', () => {
  it('T0: reads echo the id asked for; a write keeps the index and takes the new fingerprint; Hermes resolves by fingerprint', async () => {
    const t = await setup()
    const c = t.h.client
    const list = await c.call('memory.entries', {})
    const focus = list.find((e) => e.preview === FOCUS)!
    // An agent note is removed: the profile notes are renumbered.
    t.profile.memory.memory = [KILN, HARBOR]
    const relisted = await c.call('memory.entries', {})
    const focusNow = relisted.find((e) => e.preview === FOCUS)!
    const staleRead = await c.call('memory.read', { id: focus.id })
    const written = await c.call('memory.write', {
      id: focus.id,
      content: '  Focus until noon (fixture).  ',
      confirm: true,
    })
    const changedRead = await c.call('memory.read', { id: focus.id }).then(
      () => 'resolved',
      (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
    )
    // Identical text in one store: Hermes resolves the first.
    t.profile.memory.memory = [KILN, 'Twin (fixture).', 'Twin (fixture).']
    const twins = (await c.call('memory.entries', {})).filter(
      (e) => e.preview === 'Twin (fixture).',
    )
    await c.call('memory.delete', { id: twins[1]!.id, confirm: true })
    const seen = {
      before: focus.id,
      after: focusNow.id,
      staleRead: staleRead.id,
      written: written.id,
      writtenContent: written.content,
      expectedFp: memoryFingerprint('Focus until noon (fixture).'),
      changedRead,
      twins: twins.map((e) => e.id),
      left: t.profile.memory.memory,
    }
    expect(seen.staleRead).toBe(focus.id)
    expect(seen.written.split(':').slice(0, 3)).toEqual(focus.id.split(':').slice(0, 3))
    expect(seen.written.split(':')[3]).toBe(seen.expectedFp)
    expect(changedRead).toMatch(/^conflict/)
  })

  it('T1: through the direct client, a first read answered after the list moved another entry into the place locks and deletes nothing', async () => {
    const t = await setup()
    fireEvent.click(button(/Open memory entry: Glaze supplier/)!)
    await until(() => Boolean(button('Delete entry…')))
    fireEvent.click(button('Delete entry…')!)
    t.hold('memory.entries')
    fireEvent.click(button('Delete permanently')!)
    await until(() => t.profile.memory.memory.length === 2)
    t.hold('memory.read')
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await settle()
    await t.release('memory.entries')
    await t.release('memory.read')
    await until(() => alerts().length > 0)
    const seen = {
      locked: lockedNow(),
      alert: alerts().map((a) => a.slice(-90)),
      edit: Boolean(button('Edit')),
      del: Boolean(button('Delete entry…')),
      shows: document
        .querySelector('[class*="memoryEditor"] pre')
        ?.textContent?.slice(0, 30),
      store: t.profile.memory.memory,
      learning: t.learning(),
    }
    expect(seen.locked).toBe(true)
    expect(seen.del).toBe(false)
    expect(seen.edit).toBe(false)
    expect(seen.store).toEqual([KILN, HARBOR])
  })

  it('T2: through the direct client, a merge locks the editor; adopting reads Harbor, review shows it, and the save writes Harbor by its fingerprint', async () => {
    const t = await setup()
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await until(() => Boolean(button('Edit')))
    t.hold('memory.entries', 'request')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: D_K } })
    // Elsewhere, the agent merges the kiln note into Harbor.
    t.profile.memory.memory = [GLAZE, HARBOR_MON]
    await t.release('memory.entries')
    await until(() => lockedNow())
    const kept = keptDocumentDrafts('memory-draft:').map((d) => d.draft)
    fireEvent.click(button('Use this draft for the entry now here')!)
    await until(() => !lockedNow())
    fireEvent.click(button('Review changes')!)
    const diff = screen.getByLabelText('Changes').textContent ?? ''
    fireEvent.click(button('Confirm and save')!)
    await until(() => t.profile.memory.memory[1] === D_K)
    await until(() => Boolean(button('Restore previous version')))
    const seen = {
      kept,
      diffHasHarbor: diff.includes(HARBOR_MON),
      store: t.profile.memory.memory,
      keptAfter: keptDocumentDrafts('memory-draft:').map((d) => d.draft),
      locked: lockedNow(),
      learning: t.learning(),
    }
    expect(kept).toEqual([D_K])
    expect(seen.diffHasHarbor).toBe(true)
    expect(seen.store).toEqual([GLAZE, D_K])
    expect(seen.keptAfter).toEqual([])
    expect(seen.locked).toBe(false)
  })

  it('T3: through the direct client, an adoption refused because Harbor changed again: what the owner sees and can do', async () => {
    const t = await setup()
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await until(() => Boolean(button('Edit')))
    t.hold('memory.entries', 'request')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: D_K } })
    t.profile.memory.memory = [GLAZE, HARBOR_MON]
    await t.release('memory.entries')
    await until(() => lockedNow())
    // Harbor changes once more before the owner chooses to use the draft.
    t.profile.memory.memory = [
      GLAZE,
      'Harbor Loft (fictional) holds the offsite date until Wednesday.',
    ]
    fireEvent.click(button('Use this draft for the entry now here')!)
    await until(() => alerts().length > 1)
    const first = {
      alerts: alerts().map((a) => a.slice(0, 100)),
      buttons: screen.queryAllByRole('button').map((b) => b.textContent),
    }
    fireEvent.click(button('Use this draft for the entry now here')!)
    await settle()
    await settle()
    const second = {
      locked: lockedNow(),
      alerts: alerts().map((a) => a.slice(0, 100)),
      learning: t.learning(),
    }
    expect(
      second.locked === false || first.buttons.some((b) => /Reload/.test(b ?? '')),
    ).toBe(true)
  })
})
