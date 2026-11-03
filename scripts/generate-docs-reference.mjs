#!/usr/bin/env node
// Regenerates the handbook's generated reference tables (client operations,
// event payloads, keyboard shortcuts) from the TypeScript source.
// Usage: node scripts/generate-docs-reference.mjs [--check] [--root <repository>]
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRoot, report } from './lib/git.mjs'
import { renderGeneratedPages } from './lib/reference.mjs'
import { loadSources } from './lib/sources.mjs'

const { values } = parseArgs({
  options: { check: { type: 'boolean' }, root: { type: 'string' } },
})
const root = resolve(values.root ?? defaultRoot)
const errors = []
const changed = []
try {
  for (const page of await renderGeneratedPages(root, await loadSources(root))) {
    if (page.error) errors.push(`${page.page}: ${page.error}`)
    else if (page.current === page.expected) continue
    else if (values.check)
      errors.push(
        `${page.page} is out of date; run node scripts/generate-docs-reference.mjs`,
      )
    else {
      await writeFile(page.path, page.expected)
      changed.push(page.page)
    }
  }
} catch (error) {
  errors.push(error.message)
}
report(
  'generated reference',
  errors,
  changed.length ? `updated ${changed.join(', ')}` : 'all generated tables are current',
)
