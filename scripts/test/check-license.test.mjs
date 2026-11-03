import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { expectedLicence } from '../lib/license.mjs'
import { makeRepo, readRepoFile, run } from './helpers.mjs'

// The real LICENSE and README licence section carry the pinned copyright line;
// the fixtures reuse them instead of repeating the holder's name here.
const LICENSE = readRepoFile('LICENSE')
const readme = readRepoFile('README.md')
const LICENCE_SECTION = readme
  .slice(readme.search(/^## Licen[cs]e\s*$/m))
  .split(/\n## /)[0]
const MIT_FILE =
  'MIT License\n\nPermission is hereby granted, free of charge, to any person.\n'
const OFL_FILE = 'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n'
const FONT = Buffer.from('synthetic font bytes\n')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const manifest = (name, license = 'MIT', extra = {}) =>
  `${JSON.stringify({ name, private: true, license, ...extra }, null, 2)}\n`

const NOTICES = `# Third-party notices

| Material | Location | Licence | Source |
| --- | --- | --- | --- |
| Upstream schema subset | \`packages/adapter/upstream/v1/subset.json\` | MIT; full text in \`packages/adapter/upstream/LICENSE.upstream\` | upstream tag v1 |
| Sans (fonts) | \`packages/tokens/fonts/sans/\` | SIL Open Font License 1.1; text in \`OFL.txt\` alongside the fonts | upstream release v2 |

Checksums are in \`packages/tokens/fonts/SHA256SUMS\`.
`

const GOOD = {
  LICENSE,
  'README.md': `# Fixture\n\nAbout it.\n\n${LICENCE_SECTION}`,
  'THIRD_PARTY_NOTICES.md': NOTICES,
  'package.json': manifest('fixture'),
  'packages/adapter/package.json': manifest('@fixture/adapter'),
  'packages/adapter/upstream/v1/subset.json': '{}\n',
  'packages/adapter/upstream/LICENSE.upstream': MIT_FILE,
  'packages/tokens/package.json': manifest('@fixture/tokens', '(MIT AND OFL-1.1)'),
  'packages/tokens/fonts/sans/Sans.woff2': FONT,
  'packages/tokens/fonts/sans/OFL.txt': OFL_FILE,
  'packages/tokens/fonts/SHA256SUMS': `${sha256(FONT)}  sans/Sans.woff2\n${sha256(OFL_FILE)}  sans/OFL.txt\n`,
}

function check(t, changes = {}) {
  const dir = makeRepo(t, { ...GOOD, ...changes })
  return run('check-license.mjs', ['--root', dir])
}

function assertFails(result, pattern) {
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, pattern)
}

describe('check-license', () => {
  it('passes a correctly licensed repository', (t) => {
    const result = check(t)
    assert.equal(result.code, 0, result.output)
    assert.match(
      result.output,
      /3 package manifests are private with the expected licence/,
    )
  })

  it('rejects another copyright holder', (t) => {
    const other = LICENSE.replace(/^(Copyright \(c\) \d{4}) .+$/m, '$1 Avery Example')
    assertFails(check(t, { LICENSE: other }), /copyright line is not the pinned one/)
  })

  it('rejects a changed licence text', (t) => {
    const changed = LICENSE.replace('free of charge', 'for a fee')
    assertFails(check(t, { LICENSE: changed }), /not the standard MIT licence text/)
    assertFails(check(t, { LICENSE: null }), /LICENSE is missing/)
  })

  it('requires the README licence section to state the same licence', (t) => {
    assertFails(
      check(t, { 'README.md': '# Fixture\n\n## Licence\n\nMIT.\n' }),
      /README\.md: the licence section must say MIT/,
    )
  })

  it('requires private packages with the expected licence', (t) => {
    assertFails(
      check(t, {
        'packages/adapter/package.json': manifest('@fixture/adapter', 'Apache-2.0'),
      }),
      /packages\/adapter\/package\.json: "license" must be "MIT"/,
    )
    assertFails(
      check(t, { 'package.json': manifest('fixture', 'MIT', { private: false }) }),
      /package\.json: "private" must be true/,
    )
    assertFails(
      check(t, { 'packages/tokens/package.json': manifest('@fixture/tokens', 'MIT') }),
      /"license" must be "\(MIT AND OFL-1\.1\)" because it ships Sans \(fonts\)/,
    )
  })

  it('requires every notice location and licence file to exist', (t) => {
    assertFails(
      check(t, { 'packages/adapter/upstream/v1/subset.json': null }),
      /location packages\/adapter\/upstream\/v1\/subset\.json is not in the repository/,
    )
    assertFails(
      check(t, { 'packages/adapter/upstream/LICENSE.upstream': null }),
      /licence file packages\/adapter\/upstream\/LICENSE\.upstream is missing/,
    )
    assertFails(
      check(t, { 'packages/tokens/fonts/sans/OFL.txt': 'Some other licence\n' }),
      /OFL\.txt: does not contain the OFL-1\.1 licence text/,
    )
  })

  it('requires a notice for every third-party file', (t) => {
    assertFails(
      check(t, { 'packages/web/vendor/chart.js': 'export {}\n' }),
      /packages\/web\/vendor\/chart\.js: third-party material without a THIRD_PARTY_NOTICES\.md entry/,
    )
  })

  it('verifies checksum lists', (t) => {
    assertFails(
      check(t, { 'packages/tokens/fonts/sans/Sans.woff2': Buffer.from('replaced\n') }),
      /SHA256SUMS: checksum mismatch for sans\/Sans\.woff2/,
    )
    assertFails(
      check(t, { 'packages/tokens/fonts/sans/Extra.woff2': FONT }),
      /SHA256SUMS: does not list sans\/Extra\.woff2/,
    )
  })

  it('builds SPDX AND expressions', () => {
    assert.equal(expectedLicence(['MIT']), 'MIT')
    assert.equal(expectedLicence(['MIT', 'MIT']), 'MIT')
    assert.equal(expectedLicence(['OFL-1.1', 'MIT']), '(MIT AND OFL-1.1)')
  })
})
