#!/usr/bin/env node
// Handbook coverage gate: every capability, client operation, event, error
// code, keyboard shortcut and pinned Hermes name in the source is documented,
// nothing documented is stale, generated reference tables match the code and
// no page is a placeholder. Rules live in scripts/lib/coverage.mjs.
// Usage: node scripts/check-docs-coverage.mjs [--root <repository>]
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkCoverage } from './lib/coverage.mjs'
import { defaultRoot, report } from './lib/git.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' } } })
try {
  const { errors, summary } = await checkCoverage(resolve(values.root ?? defaultRoot))
  report('docs coverage', errors, summary)
} catch (error) {
  report('docs coverage', [error.message], '')
}
