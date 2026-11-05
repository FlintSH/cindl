// TEST-ONLY page for e2e/focus.spec.ts, served by its own Vite dev server and
// never part of a build. It mounts the real Library > Memory and Agent >
// Identity views on a synthetic client that Playwright can hold, refuse and
// change (window.harness), so focus is checked in a real browser where jsdom
// cannot show it: a browser drops focus from a disabled control one frame
// later. Memory is shaped like Hermes's (ids by store, global index and text
// fingerprint, card titles cut as Hermes cuts them); SOUL comes from the
// synthetic scenario. Synthetic data only.
import { sha256Hex } from '@cindl/client-core'
import { CindlProvider } from '@cindl/client-react'
import {
  CindlError,
  type CindlClientApi,
  type CindlEvent,
  type ErrorCode,
} from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentView } from '../../src/agent/AgentView.tsx'
import { LibraryView } from '../../src/library/LibraryView.tsx'
import { AppShell } from '../../src/shell/AppShell.tsx'
import '../../src/styles/global.css'

type Store = 'memory' | 'profile'
type Entry = { store: Store; content: string }
const fp = (content: string) => sha256Hex(content.trim()).slice(0, 12)
const entries: Entry[] = [
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
]
const ordered = () => [
  ...entries.filter((e) => e.store === 'memory'),
  ...entries.filter((e) => e.store === 'profile'),
]
const idOf = (e: Entry) => `memory:${e.store}:${ordered().indexOf(e)}:${fp(e.content)}`
const find = (id: string) => {
  const [, store, , fingerprint] = id.split(':')
  const e = entries.find((c) => c.store === store && fp(c.content) === fingerprint)
  if (!e)
    throw new CindlError(
      'conflict',
      'This memory entry changed since you read it. Reload it and review again.',
    )
  return e
}
const now = () => new Date(Date.UTC(2026, 10, 3, 9, 0)).toISOString()
const ops: Record<string, (args: never) => unknown> = {
  'memory.entries': () =>
    ordered().map((e) => {
      const first = (e.content.split('\n')[0] ?? '').trim().replace(/^#+\s*/, '')
      return {
        id: idOf(e),
        store: e.store,
        title: first.length > 80 ? `${first.slice(0, 80)}…` : first,
        preview: e.content.slice(0, 1200),
        truncated: e.content.length > 1200,
      }
    }),
  'memory.read': ({ id }: { id: string }) => {
    const e = find(id)
    return { id, store: e.store, content: e.content, readAt: now(), source: 'harness' }
  },
  'memory.write': ({ id, content }: { id: string; content: string }) => {
    const e = find(id)
    e.content = content.trim()
    const [, store, index] = id.split(':')
    return {
      id: `memory:${store}:${index}:${fp(e.content)}`,
      store: e.store,
      content: e.content,
      readAt: now(),
      source: 'harness',
    }
  },
  'memory.delete': ({ id }: { id: string }) => {
    entries.splice(entries.indexOf(find(id)), 1)
    return { deleted: true }
  },
}
const scenario = createScenarioClient({ speed: 0 })
const held = new Map<string, 'request' | 'answer'>()
const releases = new Map<string, () => void>()
const failures = new Map<string, { times: number; error: CindlError }>()
const listeners = new Set<(event: CindlEvent) => void>()
const api: CindlClientApi = {
  call: (async (name: string, args: unknown) => {
    const mode = held.get(name)
    if (mode) held.delete(name)
    const gate = () => new Promise<void>((resolve) => releases.set(name, resolve))
    if (mode === 'request') await gate()
    let result: unknown
    let error: unknown
    const failure = failures.get(name)
    if (failure && failure.times > 0) {
      failure.times -= 1
      error = failure.error
    } else
      try {
        const op = ops[name]
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
  subscribe: (listener) => {
    listeners.add(listener)
    const stop = scenario.subscribe(listener)
    return () => {
      listeners.delete(listener)
      stop()
    }
  },
}
const harness = {
  /** Deliver a synthetic update to the real store and views. */
  emit: (event: CindlEvent) => {
    for (const listener of listeners) listener(event)
  },
  /** Hold the next call before Hermes sees it, or let Hermes answer and hold the answer. */
  hold: (name: string, mode: 'request' | 'answer') => void held.set(name, mode),
  held: (name: string) => releases.has(name),
  release: (name: string) => {
    const resolve = releases.get(name)
    releases.delete(name)
    resolve?.()
  },
  fail: (name: string, code: ErrorCode, message: string, times = 1) =>
    void failures.set(name, { times, error: new CindlError(code, message) }),
  remove: (text: string) => {
    const at = entries.findIndex((e) => e.content.includes(text))
    if (at >= 0) entries.splice(at, 1)
  },
  replace: (text: string, content: string) => {
    const e = entries.find((c) => c.content.includes(text))
    if (e) e.content = content
  },
}
;(window as unknown as { harness: typeof harness }).harness = harness
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CindlProvider api={api}>
      {location.hash.startsWith('#/talk') ? (
        <AppShell />
      ) : location.hash === '#soul' ? (
        <AgentView section="identity" />
      ) : (
        <LibraryView section="memory" />
      )}
    </CindlProvider>
  </StrictMode>,
)
