// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

// Proves the invariants in eslint.config.mjs fire on the code they target.
const cwd = fileURLToPath(new URL('../../..', import.meta.url))
// Probe snippets are not files in any tsconfig, so type-aware parsing is off; the
// invariants under test are syntactic. A null ruleId (parse error) fails the test.
const eslint = new ESLint({ cwd, overrideConfig: tseslint.configs.disableTypeChecked })
const rulesFor = async (code: string, filePath = 'apps/web/src/probe.ts') => {
  const [result] = await eslint.lintText(code, { filePath })
  const messages = result?.messages ?? []
  const parseErrors = messages.filter((m) => m.ruleId === null).map((m) => m.message)
  expect(parseErrors).toEqual([])
  return messages.map((m) => m.ruleId)
}

describe('Cindl lint invariants', () => {
  it.each([
    ["import { scenarioData } from '@cindl/fixtures'", 'no-restricted-imports'],
    ["import { x } from '../../fixtures/src/index.ts'", 'no-restricted-imports'],
    [
      "export const load = () => import('../../fixtures/src/index.ts')",
      'no-restricted-syntax',
    ],
    [
      "import { x } from '../../../packages/fixtures/src/index.ts'",
      'no-restricted-imports',
    ],
    [
      "export const load = () => import('@cindl/fixtures/scenario')",
      'no-restricted-syntax',
    ],
    [
      "export const load = () => import('../../../packages/fixtures/src/index.ts')",
      'no-restricted-syntax',
    ],
    [
      "const name = '@cindl/fixtures/scenario'\nexport const load = () => import(name)",
      'no-restricted-syntax',
    ],
    [
      "export const load = () => import(`@cindl/${'fixtures'}/scenario`)",
      'no-restricted-syntax',
    ],
    [
      "declare const require: (id: string) => unknown\nexport const x = require('@cindl/fixtures')",
      'no-restricted-syntax',
    ],
    // Review 898a8eaa S6: routes that bypassed the import rules.
    ["import { x } from '../node_modules/@cindl/fixtures'", 'no-restricted-imports'],
    [
      "export const load = () => import('../node_modules/@cindl/fixtures/src/index.ts')",
      'no-restricted-syntax',
    ],
    [
      "export const all = import.meta.glob('../../../packages/fixtures/src/**')",
      'no-restricted-syntax',
    ],
    [
      "export const url = new URL('../../../packages/fixtures/src/scenario/data.ts', import.meta.url)",
      'no-restricted-syntax',
    ],
    [
      "const name = 'data'\nexport const url = new URL(`../${name}.ts`, import.meta.url)",
      'no-restricted-syntax',
    ],
  ])('blocks fixture access: %s', async (code, rule) => {
    expect(await rulesFor(code)).toContain(rule)
  })

  it.each([
    ["localStorage.setItem('t', 'x')", 'no-restricted-globals'],
    ["window.localStorage.setItem('t', 'x')", 'no-restricted-properties'],
    ["globalThis.localStorage.setItem('t', 'x')", 'no-restricted-properties'],
    ["self.sessionStorage.setItem('t', 'x')", 'no-restricted-properties'],
    ["indexedDB.open('t')", 'no-restricted-globals'],
    ["document.cookie = 't=1'", 'no-restricted-properties'],
    ["window['localStorage'].setItem('t', 'x')", 'no-restricted-syntax'],
    ["window.document.cookie = 't=1'", 'no-restricted-syntax'],
    ["void caches.open('t')", 'no-restricted-globals'],
    ["void window.caches.open('t')", 'no-restricted-properties'],
    ["void cookieStore.get('t')", 'no-restricted-globals'],
    ['void navigator.storage.persist()', 'no-restricted-properties'],
    ["globalThis['sessionStorage'].setItem('t', 'x')", 'no-restricted-syntax'],
    ["document['cookie'] = 't=1'", 'no-restricted-syntax'],
    ['const { localStorage: store } = window\nstore.clear()', 'no-restricted-syntax'],
    [
      'const { indexedDB } = globalThis\nvoid indexedDB.open("x")',
      'no-restricted-syntax',
    ],
    // Review 898a8eaa N1: aliases and other routes to the same objects.
    ["const w = window\nw.localStorage.setItem('t', 'x')", 'no-restricted-syntax'],
    ["window.window.localStorage.setItem('t', 'x')", 'no-restricted-syntax'],
    ['void (0, window).localStorage.length', 'no-restricted-syntax'],
    ["document.defaultView?.localStorage.setItem('t', 'x')", 'no-restricted-syntax'],
    ["top?.localStorage.setItem('t', 'x')", 'no-restricted-syntax'],
    ["export const s = Reflect.get(window, 'localStorage')", 'no-restricted-syntax'],
    [
      "export const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')",
      'no-restricted-syntax',
    ],
    [
      "const k = ['local', 'Storage'].join('')\nexport const s: unknown = window[k as 'name']",
      'no-restricted-syntax',
    ],
    // Review d2ace34c S-3: more routes to the same objects.
    ['void window.navigator.storage.getDirectory()', 'no-restricted-syntax'],
    ['void globalThis.navigator.storage.persist()', 'no-restricted-syntax'],
    ['const n = navigator\nvoid n.storage.persist()', 'no-restricted-syntax'],
    [
      "const k = ['local', 'Storage'].join('')\nexport const v: unknown = document.defaultView?.[k as 'name']",
      'no-restricted-syntax',
    ],
    ['const view = document.defaultView\nexport const v = view', 'no-restricted-syntax'],
    [
      "export const s: unknown = Reflect.get(window, ['local', 'Storage'].join(''))",
      'no-restricted-syntax',
    ],
    [
      "export const d = Object.getOwnPropertyDescriptor(Document.prototype, ['coo', 'kie'].join(''))",
      'no-restricted-syntax',
    ],
  ])('blocks browser storage: %s', async (code, rule) => {
    expect(await rulesFor(code)).toContain(rule)
  })

  it('blocks raw HTML injection', async () => {
    const rules = await rulesFor(
      'export const X = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />',
      'apps/web/src/probe.tsx',
    )
    expect(rules).toContain('no-restricted-syntax')
  })

  it.each([
    // Review d2ace34c S-4: the demo switch gets one literal import and nothing else.
    [
      "export const all = import.meta.glob('../../../packages/fixtures/src/**')",
      'no-restricted-syntax',
    ],
    ["export { scenarioData } from '@cindl/fixtures'", 'no-restricted-imports'],
    [
      "const p = 'data'\nexport const url = new URL(`../${p}.ts`, import.meta.url)",
      'no-restricted-syntax',
    ],
    ["export const load = () => import('@cindl/fixtures/other')", 'no-restricted-syntax'],
    ['void localStorage.getItem("x")', 'no-restricted-globals'],
  ])('keeps the demo switch narrow: %s', async (code, rule) => {
    expect(await rulesFor(code, 'apps/web/src/platform/client.ts')).toContain(rule)
  })

  it.each([
    [
      "import { x } from '../../../packages//fixtures//src/index.ts'",
      'no-restricted-imports',
    ],
    [
      "export const load = () => import('../../../packages//fixtures//src/index.ts')",
      'no-restricted-syntax',
    ],
  ])('blocks fixture paths with repeated slashes: %s', async (code, rule) => {
    expect(await rulesFor(code)).toContain(rule)
  })

  it.each([
    ["window.sessionStorage.setItem('t', 'x')", 'no-restricted-properties'],
    ["void indexedDB.open('t')", 'no-restricted-globals'],
    ["void window.caches.open('t')", 'no-restricted-properties'],
    ["document.cookie = 't=1'", 'no-restricted-properties'],
    ['void navigator.storage.persist()', 'no-restricted-properties'],
    ["window['sessionStorage'].setItem('t', 'x')", 'no-restricted-syntax'],
  ])('allows only localStorage in preferences.ts: %s', async (code, rule) => {
    expect(await rulesFor(code, 'apps/web/src/platform/preferences.ts')).toContain(rule)
  })

  // Review 91f30e07 N1: casts and comma expressions around a global object.
  it.each([
    'const w = globalThis as unknown as Record<string, unknown>\nexport const v = w[k]',
    'export const v = (window as unknown as Record<string, unknown>)[k]',
    'export const v = (document.defaultView as unknown as Record<string, unknown>)[k]',
    'export const v = (window satisfies object as Record<string, unknown>)[k]',
    'export const v = (0, window)[k]',
    'export const v = Reflect.get(globalThis as object, k)',
    'export const v = Object.getOwnPropertyDescriptor(window as object, k)',
    'const view = document.defaultView!\nexport const v = view',
    'let w: unknown\nw = window\nexport const v = w',
  ])('sees through casts and commas: %s', async (code) => {
    expect(await rulesFor(`declare const k: string\n${code}`)).toContain(
      'no-restricted-syntax',
    )
  })

  it('sees a storage name through a cast everywhere, tests included', async () => {
    const code =
      "export const v = (globalThis as unknown as Record<string, unknown>)['localStorage' as string]"
    expect(await rulesFor(code, 'apps/web/test/probe.ts')).toContain(
      'no-restricted-syntax',
    )
  })

  // Review 91f30e07 SF1: apps/desktop has its own config that spreads the root
  // one; the root's scoped rules must still reach its sources.
  it.each([
    [
      'apps/desktop/src/preload/probe.ts',
      "const w = window\nexport const v = w.localStorage.getItem('t')",
    ],
    ['apps/desktop/src/preload/probe.ts', 'export const c = (d: Document) => d.cookie'],
    ['apps/desktop/src/shared/probe.ts', 'export const c = (d: Document) => d.cookie'],
    [
      'apps/desktop/src/main/probe.ts',
      "const name = 'x.css'\nexport const url = new URL(name, import.meta.url)",
    ],
    [
      'apps/desktop/src/main/probe.ts',
      'declare const k: string\nexport const v = globalThis[k]',
    ],
  ])(
    'applies the shipped-source rules to desktop sources: %s',
    async (filePath, code) => {
      expect(await rulesFor(code, filePath)).toContain('no-restricted-syntax')
    },
  )

  it('applies the any-object storage rule to browser code only', async () => {
    const header =
      'export const c = (req: { headers: { cookie?: string } }) => req.headers.cookie'
    expect(await rulesFor(header, 'apps/desktop/src/main/probe.ts')).toEqual([])
    expect(await rulesFor(header, 'apps/web/src/probe.ts')).toContain(
      'no-restricted-syntax',
    )
  })

  it('keeps the adapter out of the web UI, except the platform client', async () => {
    const code =
      "import { loginPagePath } from '@cindl/hermes-adapter'\nexport const x = loginPagePath"
    expect(await rulesFor(code, 'apps/web/src/shell/SignIn.tsx')).toContain(
      'no-restricted-imports',
    )
    expect(await rulesFor(code, 'apps/web/src/platform/client.ts')).not.toContain(
      'no-restricted-imports',
    )
    // The fixtures stay off limits in the same files.
    expect(
      await rulesFor(
        "import { x } from '@cindl/fixtures'",
        'apps/web/src/shell/SignIn.tsx',
      ),
    ).toContain('no-restricted-imports')
  })

  it('lets the demo switch load the labelled scenario', async () => {
    expect(
      await rulesFor(
        "export const load = () => import('@cindl/fixtures/scenario')",
        'apps/web/src/platform/client.ts',
      ),
    ).toEqual([])
  })

  it('lets Node scripts compute file URLs and preferences.ts use localStorage', async () => {
    expect(
      await rulesFor(
        "const name = 'tokens.css'\nexport const url = new URL(`../${name}`, import.meta.url)",
        'packages/tokens/scripts/probe.ts',
      ),
    ).not.toContain('no-restricted-syntax')
    expect(
      await rulesFor(
        "export const read = () => window.localStorage.getItem('cindl.preferences')",
        'apps/web/src/platform/preferences.ts',
      ),
    ).toEqual([])
  })

  it('allows the explicit demo switch and tests to load fixtures', async () => {
    expect(
      await rulesFor(
        "export const load = () => import('@cindl/fixtures/scenario')",
        'apps/web/src/platform/client.ts',
      ),
    ).not.toContain('no-restricted-syntax')
  })
})
