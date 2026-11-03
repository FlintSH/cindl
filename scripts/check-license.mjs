#!/usr/bin/env node
// Licence gate: LICENSE is the MIT licence with the pinned copyright line,
// README's licence section agrees, every first-party package.json is MIT and
// private, and THIRD_PARTY_NOTICES.md covers every vendored file and font with
// a licence file that exists, plus matching SHA256SUMS checksums.
// Rules live in scripts/lib/license.mjs.
// Usage: node scripts/check-license.mjs [--root <repository>]
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRoot, report } from './lib/git.mjs'
import { checkLicensing } from './lib/license.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' } } })
try {
  const { errors, summary } = checkLicensing(resolve(values.root ?? defaultRoot))
  report('licence check', errors, summary)
} catch (error) {
  report('licence check', [error.message], '')
}
