#!/usr/bin/env node
// Per-commit docs-impact gate. Every commit since this script was added that
// changes a code area must change that area's documentation in the same
// commit, or explain why nothing a reader relies on changed, as a trailer:
//
//   Docs-Impact: none - <specific rationale, at least 20 characters>
//
// Rules live in scripts/lib/docs-impact.mjs. Usage:
//   node scripts/check-docs-impact.mjs --base <commit> [--head <commit>] [--root <repository>]
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkDocsImpact } from './lib/docs-impact.mjs'
import { defaultRoot, report } from './lib/git.mjs'

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    root: { type: 'string' },
  },
})
try {
  const { errors, summary } = checkDocsImpact(
    resolve(values.root ?? defaultRoot),
    values.base,
    values.head,
  )
  report('docs impact', errors, summary)
} catch (error) {
  report('docs impact', [error.message], '')
}
