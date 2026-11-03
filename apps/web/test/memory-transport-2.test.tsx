// Re-check 5d0be84: the web memory editor through the direct client, the
// adapter and the fake Hermes on loopback. RT4, RT6 and RT8 are the reviewer's
// probes with their assertions unchanged; R10 and R11 run the flows of its
// RT5 and RT7, whose expectations this change does not adopt (see the
// commit): they assert where each draft really goes. R12 and R13 cover its
// notes on the Unsaved drafts wording and on entries Hermes gives no title.
// Synthetic data only.
import { webcrypto } from 'node:crypto'
import { CindlProvider } from '@cindl/client-react'
import { type CindlClientApi, type CindlEvent } from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
const EXTRA = 'Extra note about the studio van (fictional).'
const BRIEF = 'Prefers a short morning brief, ready before 08:30.'
const FOCUS = 'Protects focus time before 11:00 on weekdays.'
const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'
const D_H = 'Harbor draft: the offsite date moved to Monday (fictional).'
const FRESH = 'Harbor fresh draft: the offsite moves to Thursday (fictional).'

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

async function setup(memory = [GLAZE, KILN, HARBOR]) {
  const h = await directHarness({
    deps: { crypto: webCryptoProvider(webcrypto as unknown as Crypto) },
  })
  await h.waitFor(
    () => h.store.getState().capabilities['memory.text']?.state === 'available',
  )
  const profile = h.fake.store.profile('default')
  profile.memory.memory = [...memory]
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
    rest: () =>
      h.fake.calls
        .filter((c) => /learning\/(node|graph)/.test(c.name))
        .map((c) => c.name),
    graphs: () => h.fake.calls.filter((c) => /learning\/graph/.test(c.name)).length,
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
const kept = () => keptDocumentDrafts('memory-draft:').map((d) => d.draft)
const keptKeys = () => keptDocumentDrafts('memory-draft:').map((d) => d.key)
const ADOPT = 'Use this draft for the entry now here'

const A_NOTE = 'Archive shelf note (fictional).'
const B_NOTE = 'Bench note (fictional).'
const FIVE = [A_NOTE, B_NOTE, KILN, HARBOR, EXTRA]
type Setup = Awaited<ReturnType<typeof setup>>
/** Locks the open editor by changing memory while a held list reload is out. */
async function lockWith(t: Setup, memory: string[], edit?: string) {
  t.hold('memory.entries', 'request')
  fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
  await settle()
  if (edit !== undefined) {
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: edit } })
  }
  t.profile.memory.memory = memory
  await t.release('memory.entries')
  await until(() => lockedNow())
}
const offer = () =>
  Boolean(screen.queryByText('An unsaved draft for this is kept on this device:'))
/** Harbor's own draft kept; a kiln draft used for Harbor and discarded; memory ends [Bench, Harbor, Extra]. */
async function harborOffered(t: Setup) {
  fireEvent.click(button(/Open memory entry: Harbor Loft/)!)
  await until(() => Boolean(button('Edit')))
  await lockWith(t, [B_NOTE, KILN, HARBOR, EXTRA], D_H)
  fireEvent.click(button(/Close memory entry/)!)
  await settle()
  fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
  await until(() => Boolean(button('Edit')))
  await lockWith(t, [B_NOTE, HARBOR, EXTRA], D_K)
  fireEvent.click(button(ADOPT)!)
  await until(() => !lockedNow())
  fireEvent.click(button('Discard changes')!)
  await until(() => offer())
}

describe('the memory editor through the direct client (re-check 5d0be84)', () => {
  it('RT4: a list reload answered after Hermes applied a save, but before the save answer, leaves no kept copy of the saved text', async () => {
    const t = await setup()
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await until(() => Boolean(button('Edit')))
    t.hold('memory.entries', 'request')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: D_K } })
    fireEvent.click(button('Review changes')!)
    t.hold('memory.write', 'answer')
    fireEvent.click(button('Confirm and save')!)
    await until(() => t.profile.memory.memory[1] === D_K)
    await t.release('memory.entries')
    await until(() => lockedNow())
    const during = { locked: lockedNow(), keys: keptKeys() }
    await t.release('memory.write')
    await until(() => Boolean(button('Restore previous version')))
    for (let i = 0; i < 4; i++) await settle()
    const saved = { locked: lockedNow(), kept: kept(), store: t.profile.memory.memory }
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const closed = { unsaved: Boolean(screen.queryByText('Unsaved drafts')) }
    expect(during.locked).toBe(true)
    expect(during.keys).toHaveLength(1)
    expect(saved.store).toEqual([GLAZE, D_K, HARBOR])
    expect(saved.kept).toEqual([])
    expect(closed.unsaved).toBe(false)
  })

  it("RT6 (P1c): that fresh edit used for the entry now here (Harbor removed): no note claims Harbor's draft is Extra's", async () => {
    const t = await setup(FIVE)
    await harborOffered(t)
    t.hold('memory.entries', 'request')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: FRESH } })
    t.profile.memory.memory = [B_NOTE, EXTRA]
    await t.release('memory.entries')
    await until(() => lockedNow())
    fireEvent.click(button(ADOPT)!)
    await until(() => !lockedNow())
    const another = Boolean(
      screen.queryByText(/Another unsaved draft for this is kept on this device/),
    )
    fireEvent.click(button('Review changes')!)
    fireEvent.click(button('Confirm and save')!)
    await until(() => t.profile.memory.memory[1] === FRESH)
    await until(() => Boolean(button('Restore previous version')))
    const saved = { store: t.profile.memory.memory, kept: kept() }
    expect(saved.kept).toEqual([D_H])
    expect(another).toBe(false)
  })

  it('RT8 (P1g): a lock lands while a save is held, then Hermes refuses the save as stale: the draft is kept once', async () => {
    const t = await setup(FIVE)
    await harborOffered(t)
    t.hold('memory.entries', 'request')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: FRESH } })
    fireEvent.click(button('Review changes')!)
    t.hold('memory.write', 'request')
    fireEvent.click(button('Confirm and save')!)
    await settle()
    // Elsewhere Harbor is rewritten; the list asked earlier lands first and locks the editor.
    t.profile.memory.memory = [B_NOTE, HARBOR_MON, EXTRA]
    await t.release('memory.entries')
    await until(() => lockedNow())
    await t.release('memory.write')
    await until(() => alerts().some((a) => /Your draft is kept/.test(a)))
    const after = { keys: keptKeys(), drafts: kept() }
    expect(after.drafts.filter((d) => d === FRESH)).toHaveLength(1)
  })

  it("R10: a fresh edit kept beside Harbor's own draft, then Harbor moves up: the lock says it waits under Unsaved drafts, and it does, while Harbor's own draft returns with Harbor", async () => {
    const t = await setup(FIVE)
    await harborOffered(t)
    t.hold('memory.entries', 'request')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: FRESH } })
    t.profile.memory.memory = [HARBOR, EXTRA]
    await t.release('memory.entries')
    await until(() => lockedNow())
    const hint = alerts()
    const keys = keptKeys()
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const closed = {
      unsaved: Boolean(screen.queryByText('Unsaved drafts')),
      fresh: document.body.textContent?.includes(FRESH) ?? false,
    }
    fireEvent.click(button(/Open memory entry: Harbor Loft/)!)
    await until(() => Boolean(textarea()))
    const reopened = { box: textarea()?.value }
    expect(hint.join(' ')).toMatch(
      /The same text is now agent note 1\. The text you were editing is kept apart from that entry's own draft, so when you close this it stays under Unsaved drafts\./,
    )
    expect(hint.join(' ')).not.toMatch(/open it there/)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(`${keys[0]}#2`)
    expect(closed).toEqual({ unsaved: true, fresh: true })
    expect(reopened.box).toBe(D_H)
  })

  it('R11: a draft used for Harbor while its own entry is still listed; Harbor moves: the lock says the draft goes back to that entry, and it does', async () => {
    const t = await setup(FIVE)
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await until(() => Boolean(button('Edit')))
    await lockWith(t, [B_NOTE, KILN, HARBOR, EXTRA], D_K)
    // The owner reloads (slow) and uses the draft for Harbor before the list lands; meanwhile Bench is removed.
    t.hold('memory.entries', 'request')
    fireEvent.click(button('Reload')!)
    await settle()
    fireEvent.click(button(ADOPT)!)
    await until(() => !lockedNow())
    t.profile.memory.memory = [KILN, HARBOR, EXTRA]
    await t.release('memory.entries')
    await until(() => lockedNow())
    const hint = alerts()
    fireEvent.click(button(/Close/)!)
    await settle()
    const closed = {
      unsaved: Boolean(screen.queryByText('Unsaved drafts')),
      draft: document.body.textContent?.includes(D_K) ?? false,
    }
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await until(() => Boolean(textarea()) || Boolean(button('Edit')))
    const kiln = { box: textarea()?.value ?? null }
    expect(hint.join(' ')).toMatch(
      /This draft was written for agent note 1, so when you close this it goes back to that entry\./,
    )
    expect(hint.join(' ')).not.toMatch(/Unsaved drafts/)
    expect(closed).toEqual({ unsaved: false, draft: false })
    expect(kiln.box).toBe(D_K)
  })

  it("R12: a draft kept beside a listed entry's own draft is listed under Unsaved drafts, which says it holds such drafts, with the entry it was written for", async () => {
    const t = await setup(FIVE)
    await harborOffered(t)
    t.hold('memory.entries', 'request')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reload' })[0]!)
    await settle()
    fireEvent.click(button('Edit')!)
    fireEvent.change(textarea()!, { target: { value: FRESH } })
    t.profile.memory.memory = [HARBOR, EXTRA]
    await t.release('memory.entries')
    await until(() => lockedNow())
    fireEvent.click(button(/Close memory entry/)!)
    await settle()
    const unsaved = screen.getByText('Unsaved drafts').parentElement!
    expect(unsaved.textContent).toContain(
      "Text you wrote for entries Hermes no longer lists (removed, or changed elsewhere), and drafts kept beside an entry's own draft.",
    )
    expect(within(unsaved).getByText('Written for agent note 1.')).toBeTruthy()
    expect(within(unsaved).getByText(FRESH)).toBeTruthy()
    expect(kept()).toEqual([D_H, FRESH])
  })

  it('R13: Hermes gives an entry whose first line is only a heading mark an empty title; its row, the lock and the adopt button name it by its text', async () => {
    const MARKED = '#\nBench rota moved to Tuesdays (fictional).'
    const t = await setup([GLAZE, KILN, MARKED])
    expect(
      button('Open memory entry: Bench rota moved to Tuesdays (fictional).'),
    ).toBeTruthy()
    fireEvent.click(button(/Open memory entry: The kiln firing log/)!)
    await until(() => Boolean(button('Edit')))
    await lockWith(t, [GLAZE, MARKED], D_K)
    const adopt = button(ADOPT)!
    const described = document.getElementById(
      adopt.getAttribute('aria-describedby') ?? '',
    )?.textContent
    expect(described).toBe(
      'Now at this place: “Bench rota moved to Tuesdays (fictional).”.',
    )
  })
})
