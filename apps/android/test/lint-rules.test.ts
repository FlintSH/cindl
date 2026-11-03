/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

// Proves apps/android/eslint.config.mjs keeps every root invariant for Android code
// and adds Android's own. Probe snippets are in no tsconfig, so type-aware parsing is
// off; the rules under test are syntactic. A parse error fails the test.
const cwd = fileURLToPath(new URL('../../..', import.meta.url))
const eslint = new ESLint({ cwd, overrideConfig: tseslint.configs.disableTypeChecked })
const rulesFor = async (code: string, filePath = 'apps/android/src/probe.ts') => {
  const [result] = await eslint.lintText(code, { filePath })
  const messages = result?.messages ?? []
  expect(messages.filter((m) => m.ruleId === null).map((m) => m.message)).toEqual([])
  return messages.map((m) => m.ruleId)
}

describe('Android lint rules', () => {
  // Rules the root scopes to shipped and browser-facing code. A local block that set
  // no-restricted-syntax again used to replace them with the root's base list.
  const scoped = [
    'declare const k: string\nexport const v = (globalThis as unknown as Record<string, unknown>)[k]',
    'const g = globalThis\nexport const v = g',
    'let g: unknown\ng = globalThis\nexport const v = g',
    "export const s: unknown = Reflect.get(globalThis, 'localStorage')",
    'declare const jar: { cookie: string }\nexport const c = jar.cookie',
    "const name = 'x'\nexport const url = new URL(`./${name}.ts`, import.meta.url)",
  ]
  it.each(
    [
      'apps/android/src/probe.ts',
      'apps/android/index.ts',
      'apps/android/modules/x/index.ts',
    ].flatMap((file) => scoped.map((code) => [file, code] as const)),
  )('keeps the root storage and alias rules in %s: %s', async (file, code) => {
    expect(await rulesFor(code, file)).toContain('no-restricted-syntax')
  })

  it.each([
    [
      'apps/android/src/App.tsx',
      "import AsyncStorage from '@react-native-async-storage/async-storage'\nexport const s = AsyncStorage",
    ],
    [
      'apps/android/src/auth/migrate.ts',
      "import * as SecureStore from 'expo-secure-store'\nexport const s = SecureStore",
    ],
    [
      'apps/android/src/talk/probe.ts',
      "export const load = () => import('expo-secure-store')",
    ],
    [
      'apps/android/src/probe.ts',
      "export { default } from '@react-native-async-storage/async-storage'",
    ],
    [
      'apps/android/src/probe.ts',
      "export type Store = typeof import('expo-secure-store')",
    ],
    ['apps/android/index.ts', "import 'expo-secure-store'"],
  ])('keeps device storage in src/platform: %s', async (file, code) => {
    expect(await rulesFor(code, file)).toContain('cindl-android/storage-in-platform')
  })

  it('lets the platform layer open storage', async () => {
    expect(
      await rulesFor(
        "import AsyncStorage from '@react-native-async-storage/async-storage'\nexport const s = AsyncStorage",
        'apps/android/src/platform/storage.ts',
      ),
    ).toEqual([])
  })

  it.each([
    "export const accent = '#1f6feb'",
    "export const shadow = { shadowColor: 'rgba(0, 0, 0, 0.2)' }",
    'export const shadow = `0 1px 2px hsla(0, 0%, 0%, ${0.2})`',
  ])('refuses raw colours: %s', async (code) => {
    expect(await rulesFor(code)).toContain('cindl-android/no-raw-colour')
  })

  it.each(['export const t = document.title', 'export const w = window.innerWidth'])(
    'refuses DOM globals: %s',
    async (code) => {
      expect(await rulesFor(code)).toContain('cindl-android/no-dom-globals')
    },
  )

  it('allows locals named like DOM globals and text with a hash', async () => {
    expect(
      await rulesFor(
        "export const key = (document: { key: string }) => document.key\nexport const note = 'Issue #123 is fixed'",
      ),
    ).toEqual([])
  })

  it('allows the demo switch its one literal import', async () => {
    expect(
      await rulesFor(
        "export const load = () => import('@cindl/fixtures/scenario')",
        'apps/android/src/platform/client.ts',
      ),
    ).toEqual([])
  })

  it.each([
    ["export const load = () => import('@cindl/fixtures/other')", 'no-restricted-syntax'],
    [
      "const name = '@cindl/fixtures/scenario'\nexport const load = () => import(name)",
      'no-restricted-syntax',
    ],
    [
      "export const all = import.meta.glob('../../../../packages/fixtures/src/**')",
      'no-restricted-syntax',
    ],
    ["export { scenarioData } from '@cindl/fixtures'", 'no-restricted-imports'],
    ['const g = globalThis\nexport const v = g', 'no-restricted-syntax'],
  ])('keeps the demo switch narrow: %s', async (code, rule) => {
    expect(await rulesFor(code, 'apps/android/src/platform/client.ts')).toContain(rule)
  })

  it('lets the emulator harness print', async () => {
    expect(await rulesFor("console.log('step')", 'apps/android/e2e/probe.ts')).toEqual([])
  })
})
