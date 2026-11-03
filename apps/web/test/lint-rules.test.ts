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

  it('allows the explicit demo switch and tests to load fixtures', async () => {
    expect(
      await rulesFor(
        "export const load = () => import('@cindl/fixtures/scenario')",
        'apps/web/src/platform/client.ts',
      ),
    ).not.toContain('no-restricted-syntax')
  })
})
