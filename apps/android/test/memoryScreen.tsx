import { sha256Hex } from '@cindl/client-core'
import { CindlProvider } from '@cindl/client-react'
import {
  CindlError,
  type CindlClientApi,
  type CindlEvent,
  type LinkState,
  type MemoryEntry,
  type MemoryEntrySummary,
} from '@cindl/contracts'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, vi } from 'vitest'
import { MemoryEntries } from '../src/library/MemoryEntries.tsx'
import { MEMORY_DRAFT_PREFIX } from '../src/library/memory.ts'
import { NavProvider } from '../src/nav/NavProvider.tsx'
import { PortalHost } from '../src/overlay/Portal.tsx'
import { useSessionDrafts } from '../src/shell/sessionDrafts.ts'
import { KeyboardProvider } from '../src/shell/keyboard.tsx'
import { MotionProvider } from '../src/theme/motion.tsx'
import { ThemeProvider } from '../src/theme/theme.tsx'
import { keptDocumentDrafts } from '../src/views/drafts.ts'
import { nativeLog, resetNative } from './render/react-native.tsx'

/*
 * The Library's Memory screen for Node tests: the shipped MemoryEntries,
 * EntryEditor, DeleteEntry and DocumentEditor, rendered with react-dom in
 * jsdom inside the app's providers (src/App.tsx), on a Cindl API that answers
 * from a synthetic memory (`harness`) or from a test's own `call`. React
 * Native's host layer is test/render/react-native.tsx; files that render run
 * in jsdom (`@vitest-environment jsdom`).
 *
 * - A press or a change acts on the element on screen and renders at once, as
 *   a React event does. Answers, effects that follow them and timers (fake,
 *   advanced 100 ms a round) render when the test settles.
 * - While a dialog is open, only its buttons can be pressed (its scrim covers
 *   the rest).
 * - The screen is read like the web tests read the DOM: roles, accessible
 *   names and text, as TalkBack would. React errors fail the test.
 *
 * SYNTHETIC data only.
 */

type Call = CindlClientApi['call']

export type ScreenNode =
  | {
      kind: 'text'
      text: string
      role?: 'alert' | 'header'
      live?: 'polite' | 'assertive'
      /** The document text in the editor's view stage, or the review's diff. */
      tag?: 'shown' | 'changes'
      /** The title of the dialog it is in. */
      dialog?: string
    }
  | {
      kind: 'button'
      /** The visible label. */
      label: string
      /** The accessible name: accessibilityLabel, else the label. */
      name: string
      /** What TalkBack says after the name (accessibilityHint). */
      hint?: string
      disabled: boolean
      dialog?: string
      element: HTMLElement
    }
  | {
      kind: 'field'
      label: string
      value: string
      readOnly: boolean
      element: HTMLTextAreaElement | HTMLInputElement
    }

const matches = (value: string, match: string | RegExp) =>
  typeof match === 'string' ? value === match : match.test(value)

/** Memory writes are available, as Hermes reports them for the fixture. */
const capabilities: CindlEvent = {
  type: 'capabilities.changed',
  capabilities: {
    'memory.text': {
      id: 'memory.text',
      state: 'available',
      source: { transport: 'none', endpoint: 'synthetic memory' },
      checkedAt: '2026-11-03T09:00:00.000Z',
    },
  },
}

/** What React logged while this test rendered: any error fails the test. */
let watch: { errors: string[]; restore: () => void } | undefined
function watchReact() {
  if (watch) return
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
  watch = { errors, restore: () => spy.mockRestore() }
}
afterEach(() => {
  cleanup()
  resetNative()
  vi.useRealTimers()
  const seen = watch
  watch = undefined
  seen?.restore()
  if (seen?.errors.length) throw new Error(`React reported an error: ${seen.errors[0]}`)
})

/** Every pending promise callback runs (a real macrotask turn). */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve))

function Providers({ api, children }: { api: CindlClientApi; children: ReactNode }) {
  return (
    <ThemeProvider preference="system">
      <MotionProvider>
        <KeyboardProvider>
          <CindlProvider api={api}>
            <NavProvider>
              <PortalHost>{children}</PortalHost>
            </NavProvider>
          </CindlProvider>
        </KeyboardProvider>
      </MotionProvider>
    </ThemeProvider>
  )
}

/** The screen, on `api.call`. */
export function memoryScreen(api: { call: Call }) {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  watchReact()
  // Calls started or answered: a settle ends once a round changes nothing.
  let activity = 0
  const client: CindlClientApi = {
    call: async (name: string, args: unknown) => {
      activity += 1
      try {
        return await api.call(name as never, args as never)
      } finally {
        activity += 1
      }
    },
    subscribe: (listener) => {
      listener(capabilities)
      return () => undefined
    },
  }
  const ui = () => (
    <Providers api={client}>
      <div data-screen="">
        <MemoryEntries />
      </div>
    </Providers>
  )
  let mounted: ReturnType<typeof render> | undefined = render(ui())
  /** Gates to open at the start of the next settle, inside act. */
  const opening: Array<() => void> = []

  const root = () => mounted?.container.querySelector<HTMLElement>('[data-screen]')
  /** The title of the dialog an element is in (portal content beside the screen). */
  const dialogOf = (element: Element): string | undefined => {
    const screen = root()
    if (!screen || screen.contains(element)) return undefined
    let frame: Element | null = element
    while (frame && frame.parentElement !== screen.parentElement)
      frame = frame.parentElement
    return frame?.querySelector('[role="heading"]')?.textContent ?? ''
  }
  const hidden = (element: Element) => Boolean(element.closest('[aria-hidden="true"]'))
  const textOf = (element: Element) => element.textContent ?? ''

  /** Every node on screen, in order. */
  function nodes(): ScreenNode[] {
    const container = mounted?.container
    if (!container) return []
    const out: ScreenNode[] = []
    let changes: Extract<ScreenNode, { kind: 'text' }> | undefined
    const selectable = new Set<ScreenNode>()
    for (const element of container.querySelectorAll<HTMLElement>(
      '[role="button"], [data-rn="Text"], [data-rn="TextInput"]',
    )) {
      if (hidden(element)) continue
      const dialog = dialogOf(element)
      const inDialog = dialog === undefined ? {} : { dialog }
      if (element.getAttribute('role') === 'button') {
        const label = [...element.querySelectorAll('[data-rn="Text"]')]
          .map(textOf)
          .join('')
        const hint = element.getAttribute('aria-description')
        out.push({
          kind: 'button',
          label,
          name: element.getAttribute('aria-label') ?? label,
          ...(hint ? { hint } : {}),
          disabled: element.getAttribute('aria-disabled') === 'true',
          ...inDialog,
          element,
        })
      } else if (element.dataset.rn === 'TextInput') {
        const field = element as HTMLTextAreaElement | HTMLInputElement
        out.push({
          kind: 'field',
          label: field.getAttribute('aria-label') ?? '',
          value: field.value,
          readOnly: field.readOnly,
          element: field,
        })
      } else {
        // Text: the outermost only (nested Text is part of it), and not a button's label.
        if (element.parentElement?.closest('[data-rn="Text"], [role="button"]')) continue
        const role = element.getAttribute('role')
        const live = element.getAttribute('aria-live')
        if (element.closest('[aria-label="Changes"]')) {
          // The review's diff: one text, a line each, as the screen shows it.
          if (changes) changes.text += `\n${textOf(element)}`
          else {
            changes = { kind: 'text', text: textOf(element), tag: 'changes', ...inDialog }
            out.push(changes)
          }
          continue
        }
        const node: ScreenNode = {
          kind: 'text',
          text: textOf(element),
          ...(role === 'alert' ? { role: 'alert' as const } : {}),
          ...(role === 'heading' ? { role: 'header' as const } : {}),
          ...(live === 'polite' || live === 'assertive' ? { live } : {}),
          ...inDialog,
        }
        if (element.dataset.selectable !== undefined) selectable.add(node)
        out.push(node)
      }
    }
    // The document the editor shows: the selectable text just above "Read … Version …".
    const read = out.findIndex(
      (node) =>
        node.kind === 'text' && /^Read .* from .*\. Version \S+\.$/.test(node.text),
    )
    for (let index = read - 1; read > 0 && index >= 0; index--) {
      const node = out[index]
      if (node?.kind === 'text' && selectable.has(node)) {
        node.tag = 'shown'
        break
      }
    }
    return out
  }

  const buttons = (name: string | RegExp) =>
    nodes().filter(
      (node): node is Extract<ScreenNode, { kind: 'button' }> =>
        node.kind === 'button' && matches(node.name, name),
    )
  const texts = () =>
    nodes().filter(
      (node): node is Extract<ScreenNode, { kind: 'text' }> => node.kind === 'text',
    )
  const fields = () =>
    nodes().filter(
      (node): node is Extract<ScreenNode, { kind: 'field' }> => node.kind === 'field',
    )
  const inDialog = () => {
    const screen = root()
    return Boolean(screen?.parentElement && screen.parentElement.children.length > 1)
  }
  /** What changes when anything on screen or in flight does. */
  const fingerprint = () =>
    [
      mounted?.container.innerHTML ?? '',
      activity,
      nativeLog.length,
      JSON.stringify(keptDocumentDrafts(MEMORY_DRAFT_PREFIX)),
    ].join('\u0000')

  return {
    nodes,
    /** Lets every answer that is not held arrive, and timers run, rendering after each. */
    settle: async () => {
      for (let round = 0; round < 100; round++) {
        const before = fingerprint()
        await act(async () => {
          for (const open of opening.splice(0)) open()
          await drain()
          await vi.advanceTimersByTimeAsync(100)
          await drain()
        })
        if (fingerprint() === before) return
      }
      throw new Error('the screen never settled')
    },
    /** Opens a held gate at the start of the next settle. */
    later: (open: () => void) => void opening.push(open),
    /** Leaves the screen and comes back: every component state is new. */
    remount: () => {
      mounted?.unmount()
      mounted = render(ui())
    },
    unmount: () => {
      mounted?.unmount()
      mounted = undefined
    },
    button: (name: string | RegExp) => buttons(name)[0],
    buttons,
    /** Presses a button (the nth with this name), as the owner would. */
    press: (name: string | RegExp, nth = 0) => {
      const target = buttons(name)[nth]
      if (!target) throw new Error(`no button ${String(name)}`)
      if (target.disabled) throw new Error(`${String(name)} is disabled`)
      if (inDialog() && target.dialog === undefined)
        throw new Error(`${String(name)} is behind a dialog`)
      fireEvent.click(target.element)
    },
    /** Types into the editor's text field. */
    change: (text: string, label?: string | RegExp) => {
      const target = fields().find(
        (node) => label === undefined || matches(node.label, label),
      )
      if (!target) throw new Error(`no field ${String(label)}`)
      if (target.readOnly) throw new Error(`${target.label} is read-only`)
      if (inDialog()) throw new Error(`${target.label} is behind a dialog`)
      fireEvent.change(target.element, { target: { value: text } })
    },
    field: () => fields()[0],
    /** True when a text equals the string, or matches the pattern. */
    hasText: (match: string | RegExp) =>
      texts().some((node) => matches(node.text, match)),
    alerts: () => texts().flatMap((node) => (node.role === 'alert' ? [node.text] : [])),
    /** Texts TalkBack announces politely (the web's role="status"). */
    polite: () => texts().flatMap((node) => (node.live === 'polite' ? [node.text] : [])),
    /** All text on screen, as the web's document.body.textContent (not field values). */
    body: () =>
      texts()
        .map((node) => node.text)
        .join('\n'),
    shown: () => texts().find((node) => node.tag === 'shown')?.text,
    changes: () => texts().find((node) => node.tag === 'changes')?.text,
    /**
     * Where TalkBack focus was sent, in order: the editor's box ("draft"), its
     * lock notice ("notice"), or a dialog's title.
     */
    focusLog: () =>
      nativeLog.flatMap((entry) => {
        if (entry.kind !== 'focus') return []
        const node = entry.node
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)
          return ['draft']
        if (node instanceof HTMLElement && node.getAttribute('role') === 'alert')
          return ['notice']
        if (node instanceof HTMLElement && node.getAttribute('role') === 'heading')
          return [`dialog: ${textOf(node)}`]
        return [node instanceof HTMLElement ? textOf(node) : String(node)]
      }),
    /** The text of an open dialog, title first. */
    dialog: (title: string) => {
      const inside = texts().filter((node) => node.dialog === title)
      return inside.length ? inside.map((node) => node.text).join('\n') : undefined
    },
  }
}

export type MemoryScreen = ReturnType<typeof memoryScreen>

// The web probes' fixture (apps/web/test/memory-adoption.test.tsx).
export type Store = 'memory' | 'profile'
export interface Entry {
  store: Store
  content: string
}
export const GLAZE =
  'Glaze supplier calls moved to Thursdays at 10:00 (fictional supplier).'
export const KILN =
  'The kiln firing log lives in the studio inventory sheet, tab "Firings".'
export const HARBOR = 'Harbor Loft (fictional) holds the offsite date until Friday.'
export const BRIEF = 'Prefers a short morning brief, ready before 08:30.'
export const FOCUS = 'Protects focus time before 11:00 on weekdays.'
export const fixtureEntries: Entry[] = [
  { store: 'memory', content: GLAZE },
  { store: 'memory', content: KILN },
  { store: 'memory', content: HARBOR },
  { store: 'profile', content: BRIEF },
  { store: 'profile', content: FOCUS },
]
export const fp = (content: string) => sha256Hex(content.trim()).slice(0, 12)

/**
 * Memory shaped like the fixture: ids resolve by store and fingerprint, first
 * match. `adapterWrites` answers a write like the adapter does (the web's
 * memory-drafts probes): the same index as the id written, with the new
 * fingerprint, and the text trimmed.
 */
export function memoryBackend(
  initial: Entry[],
  options: { adapterWrites?: boolean } = {},
) {
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
  const now = '2026-11-03T09:00:00.000Z'
  const ops: Record<string, (args: never) => unknown> = {
    'memory.entries': (): MemoryEntrySummary[] =>
      ordered().map((e) => ({
        id: idOf(e),
        store: e.store,
        title: (e.content.split('\n')[0] ?? '').slice(0, 60),
        preview: e.content.slice(0, 1200),
        truncated: e.content.length > 1200,
      })),
    'memory.read': ({ id }: { id: string }): MemoryEntry => {
      const e = find(id)
      return { id, store: e.store, content: e.content, readAt: now, source: 'probe' }
    },
    'memory.write': ({ id, content }: { id: string; content: string }): MemoryEntry => {
      const e = find(id)
      if (options.adapterWrites) {
        e.content = content.trim()
        const [, store, index] = id.split(':')
        return {
          id: `memory:${store}:${index}:${fp(e.content)}`,
          store: e.store,
          content: e.content,
          readAt: now,
          source: 'probe',
        }
      }
      e.content = content
      return { id: idOf(e), store: e.store, content, readAt: now, source: 'probe' }
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
    /** Replaces a store's entries, in order (as the web probes set the fake's list). */
    set: (store: Store, contents: string[]) => {
      const others = entries.filter((e) => e.store !== store)
      entries.splice(
        0,
        entries.length,
        ...others,
        ...contents.map((content) => ({ store, content })),
      )
    },
    store: (store: Store) =>
      ordered()
        .filter((e) => e.store === store)
        .map((e) => e.content),
    remove: (re: RegExp) => void entries.splice(entries.indexOf(byText(re)), 1),
    replace: (re: RegExp, content: string) => void (byText(re).content = content),
    has: (re: RegExp) => entries.some((e) => re.test(e.content)),
    contents: () => ordered().map((e) => `${e.store}: ${e.content.slice(0, 40)}`),
  }
}

export type Gate = 'memory.entries' | 'memory.read' | 'memory.write'

/** The Memory screen on the fixture, with calls that can be held or failed. */
export function harness(
  initial: Entry[] = fixtureEntries,
  options: { adapterWrites?: boolean } = {},
) {
  const mem = memoryBackend(initial, options)
  const calls: Array<{ name: string; args: unknown }> = []
  // `request`: the call waits before Hermes sees it; `answer`: Hermes acts at once and
  // the answer waits (a slow response).
  const held = new Map<Gate, 'request' | 'answer'>()
  const releases = new Map<Gate, () => void>()
  const failNext = new Map<string, CindlError>()
  const state = { refuseDeletes: false }
  let failRead = false
  const call = (async (name: string, args: unknown) => {
    calls.push({ name, args })
    const mode = held.get(name as Gate)
    if (mode) held.delete(name as Gate)
    const gate = () => new Promise<void>((resolve) => releases.set(name as Gate, resolve))
    if (mode === 'request') await gate()
    if (mode === 'answer') {
      const op = mem.ops[name]
      if (!op) throw new Error(`unexpected call ${name}`)
      let result: unknown
      let failed: Error | undefined
      try {
        result = op(args as never)
      } catch (error) {
        failed = error instanceof Error ? error : new Error(String(error))
      }
      await gate()
      if (failed) throw failed
      return result
    }
    const failure = failNext.get(name)
    if (failure) {
      failNext.delete(name)
      throw failure
    }
    if (name === 'memory.read' && failRead) {
      failRead = false
      throw new CindlError('unavailable', 'Hermes is not answering.')
    }
    if (name === 'memory.delete' && state.refuseDeletes)
      throw new CindlError('unavailable', 'Probe refused the delete.')
    const op = mem.ops[name]
    if (!op) throw new Error(`unexpected call ${name}`)
    return op(args as never)
  }) as Call
  const screen = memoryScreen({ call })
  return {
    ...screen,
    mem,
    calls,
    state,
    reads: () =>
      calls
        .filter((c) => c.name === 'memory.read')
        .map((c) => (c.args as { id: string }).id),
    failNext: (name: string, error: CindlError) => void failNext.set(name, error),
    writes: () =>
      calls
        .filter((c) => c.name === 'memory.write')
        .map((c) => c.args as { id: string; content: string }),
    deletes: () =>
      calls
        .filter((c) => c.name === 'memory.delete')
        .map((c) => c.args as { id: string }),
    hold: (gate: Gate) => void held.set(gate, 'request'),
    holdAnswer: (gate: Gate) => void held.set(gate, 'answer'),
    /** Lets a held call through; it arrives when the test settles. */
    release: (gate: Gate) => {
      const resolve = releases.get(gate)
      releases.delete(gate)
      if (resolve) screen.later(resolve)
    },
    failNextRead: () => (failRead = true),
  }
}

export type Harness = ReturnType<typeof harness>

/** Kept memory drafts, oldest first. */
export const keptMemoryDrafts = () =>
  keptDocumentDrafts(MEMORY_DRAFT_PREFIX).map((d) => d.draft)

/** The editor locked: its notice says Cindl cannot tell what happened. */
export const lockedNow = (s: MemoryScreen) =>
  s.alerts().some((alert) => /cannot tell which/.test(alert))

/** Opens the row whose title matches, from the list on screen. */
export async function openEntry(s: MemoryScreen, title: RegExp) {
  await s.settle()
  s.press(new RegExp(`Open memory entry: ${title.source}`))
  await s.settle()
}

/** "Edit", then the draft typed into the field with this label. */
export function editTo(s: MemoryScreen, label: string, text: string) {
  s.press('Edit')
  s.change(text, label)
}

/** Reloads the list from the open editor's view stage, holding the answer. */
export async function holdListAndReload(h: Harness) {
  h.hold('memory.entries')
  h.press('Reload')
  await h.settle()
}

export async function releaseList(h: Harness) {
  h.release('memory.entries')
  await h.settle()
}

/** AppShell's session-end hook (src/shell/sessionDrafts.ts), rendered on its own. */
export function shellSession() {
  function Shell({ link }: { link: Pick<LinkState, 'phase' | 'demo'> }) {
    useSessionDrafts(link)
    return null
  }
  let shell: ReturnType<typeof render> | undefined
  return {
    link: (link: Pick<LinkState, 'phase' | 'demo'>) => {
      if (shell) shell.rerender(<Shell link={link} />)
      else shell = render(<Shell link={link} />)
    },
  }
}

/** Kept memory drafts' keys, oldest first. */
export const keptMemoryKeys = () =>
  keptDocumentDrafts(MEMORY_DRAFT_PREFIX).map((d) => d.key)
