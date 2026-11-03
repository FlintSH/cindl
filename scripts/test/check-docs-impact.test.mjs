import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { trailerProblem, uncovered } from '../lib/docs-impact.mjs'
import { commit, git, makeRepo, run } from './helpers.mjs'

/** A repository whose second commit adopts the policy; returns the base SHA. */
function adoptedRepo(t) {
  const dir = makeRepo(t)
  const base = commit(
    dir,
    {
      'packages/contracts/src/ops.ts': 'export const ops = 1\n',
      'README.md': '# Fixture\n',
    },
    'Start the fixture',
  )
  commit(
    dir,
    {
      'scripts/check-docs-impact.mjs': '// policy marker\n',
      'docs/handbook/development/docs.md': '# Docs\n',
    },
    'Adopt the docs-impact policy',
  )
  return { dir, base }
}

const gate = (dir, base) => run('check-docs-impact.mjs', ['--root', dir, '--base', base])

describe('check-docs-impact', () => {
  it('passes a code change that updates its documentation in the same commit', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(
      dir,
      {
        'packages/contracts/src/ops.ts': 'export const ops = 2\n',
        'docs/handbook/reference/client-operations.md': '# Client operations\n',
      },
      'Add an operation',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /2 commit\(s\) in .* checked/)
  })

  it('rejects a code change without documentation or a trailer', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(
      dir,
      { 'packages/contracts/src/ops.ts': 'export const ops = 3\n' },
      'Change ops',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.match(result.output, /"Change ops": documentation was not updated/)
    assert.match(result.output, /client contract: packages\/contracts\/src\/ops\.ts/)
    assert.match(result.output, /Docs-Impact: none - /)
  })

  it('does not let a later documentation commit cover an earlier code commit', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(dir, { 'apps/web/src/App.tsx': 'export {}\n' }, 'Change the web app')
    commit(dir, { 'docs/handbook/clients/web.md': '# Web\n' }, 'Document the web app')
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.match(result.output, /"Change the web app": documentation was not updated/)
    assert.doesNotMatch(result.output, /"Document the web app"/)
  })

  it('accepts a specific Docs-Impact rationale', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(
      dir,
      { 'packages/contracts/src/ops.ts': 'export const ops = 4 // same value\n' },
      'Tidy ops\n\nDocs-Impact: none - comment-only edit in ops.ts; schemas and summaries unchanged',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /1 with a Docs-Impact rationale/)
  })

  it('rejects vague, short or malformed trailers', (t) => {
    const { dir, base } = adoptedRepo(t)
    const trailers = [
      'n/a',
      'none',
      'trivial',
      'none - trivial',
      'none - no user-visible changes needed',
      'none - small fix',
    ]
    trailers.forEach((value, index) =>
      commit(
        dir,
        { 'packages/contracts/src/ops.ts': `export const ops = ${10 + index}\n` },
        `Change ${index}\n\nDocs-Impact: ${value}`,
      ),
    )
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.equal(
      result.output.match(/Docs-Impact trailer rejected/g)?.length,
      trailers.length,
    )
  })

  it('rejects two Docs-Impact trailers in one commit', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(
      dir,
      { 'packages/contracts/src/ops.ts': 'export const ops = 5\n' },
      'Change ops\n\nDocs-Impact: none - first rationale long enough here\nDocs-Impact: none - second rationale long enough here',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.match(result.output, /has 2 Docs-Impact trailers/)
  })

  it('explains a Docs-Impact line that is not a trailer', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(
      dir,
      { 'packages/contracts/src/ops.ts': 'export const ops = 6\n' },
      'Change ops\n\nDocs-Impact: none - comment-only edit in ops.ts; schemas unchanged\n\nMore text after it.',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.match(result.output, /not in the final paragraph/)
  })

  it('skips commits made before the policy existed, and says so', (t) => {
    const dir = makeRepo(t)
    const base = commit(dir, { 'README.md': '# Fixture\n' }, 'Start')
    commit(
      dir,
      { 'packages/contracts/src/ops.ts': 'export const ops = 1\n' },
      'Pre-policy code',
    )
    commit(
      dir,
      {
        'scripts/check-docs-impact.mjs': '// policy marker\n',
        'docs/handbook/development/docs.md': '# Docs\n',
      },
      'Adopt the policy',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /1 commit\(s\) predate scripts\/check-docs-impact\.mjs/)
  })

  it('keeps checking after the policy file is deleted', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(dir, { 'scripts/check-docs-impact.mjs': null }, 'Remove the policy file')
    commit(
      dir,
      { 'packages/contracts/src/ops.ts': 'export const ops = 7\n' },
      'Change ops',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.match(result.output, /"Change ops": documentation was not updated/)
  })

  it('fails without a usable base commit instead of passing', (t) => {
    const { dir } = adoptedRepo(t)
    const missing = run('check-docs-impact.mjs', ['--root', dir])
    assert.equal(missing.code, 1)
    assert.match(missing.output, /pass --base/)
    const unknown = gate(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    assert.equal(unknown.code, 1)
    assert.match(unknown.output, /not a commit in this clone/)
    const nullCommit = gate(dir, '0000000000000000000000000000000000000000')
    assert.equal(nullCommit.code, 1)
    assert.match(nullCommit.output, /null commit/)
  })

  it('exempts Dependabot dependency updates, but not its code changes', (t) => {
    const { dir, base } = adoptedRepo(t)
    const bot = {
      GIT_AUTHOR_NAME: 'dependabot[bot]',
      GIT_AUTHOR_EMAIL: '49699333+dependabot[bot]@users.noreply.github.com',
    }
    commit(
      dir,
      {
        'package.json': '{"private":true}\n',
        'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      },
      'Bump the runtime-workspace group',
      bot,
    )
    const updates = gate(dir, base)
    assert.equal(updates.code, 0, updates.output)
    assert.match(updates.output, /1 Dependabot dependency update/)
    commit(dir, { 'apps/web/src/App.tsx': 'export {}\n' }, 'Bot edits code', bot)
    assert.equal(gate(dir, base).code, 1)
  })

  it('requires some documentation for paths no rule owns', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(dir, { 'tools/new-tool.mjs': 'export {}\n' }, 'Add a tool')
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.match(result.output, /other source: tools\/new-tool\.mjs/)
  })

  it('treats tests, Markdown and Git housekeeping as non-code', (t) => {
    const { dir, base } = adoptedRepo(t)
    commit(
      dir,
      {
        'packages/contracts/test/ops.test.ts': 'export {}\n',
        'apps/web/AGENTS.md': '# Web\n',
        '.gitignore': 'dist/\n',
      },
      'Add a test',
    )
    const result = gate(dir, base)
    assert.equal(result.code, 0, result.output)
  })

  it('checks both sides of a rename', (t) => {
    const { dir, base } = adoptedRepo(t)
    git(dir, [
      'mv',
      'packages/contracts/src/ops.ts',
      'packages/contracts/src/operations.ts',
    ])
    git(dir, ['commit', '--quiet', '-m', 'Rename ops'], {})
    const result = gate(dir, base)
    assert.equal(result.code, 1)
    assert.match(result.output, /packages\/contracts\/src\/ops\.ts/)
  })
})

describe('docs-impact rules', () => {
  it('accepts only "none - <specific rationale>"', () => {
    assert.equal(
      trailerProblem('none - comment-only edit in ops.ts; schemas unchanged'),
      null,
    )
    assert.equal(trailerProblem('none – renamed a private helper in reducer.ts'), null)
    for (const value of ['n/a', 'none', 'trivial', 'none -', 'update docs later please'])
      assert.match(trailerProblem(value), /does not read/)
    assert.match(trailerProblem('none - typo'), /at least 20/)
    assert.match(trailerProblem('none - internal refactor, no docs needed'), /generic/)
  })

  it('maps each code area to its documentation', () => {
    assert.deepEqual(
      uncovered(['packages/contracts/src/a.ts', 'docs/handbook/reference/x.md']),
      [],
    )
    assert.equal(
      uncovered(['packages/contracts/src/a.ts', 'docs/handbook/clients/web.md']).length,
      1,
    )
    assert.deepEqual(
      uncovered(['apps/web/src/a.tsx', 'docs/handbook/clients/web.md']),
      [],
    )
    assert.deepEqual(
      uncovered(['apps/desktop/src/main.ts', 'docs/handbook/clients/desktop.md']),
      [],
    )
    assert.equal(
      uncovered(['apps/desktop/src/main.ts', 'docs/handbook/clients/web.md']).length,
      1,
    )
    assert.deepEqual(
      uncovered(['scripts/x.mjs', 'docs/handbook/development/docs.md']),
      [],
    )
    assert.deepEqual(uncovered(['docs/handbook/public/screenshots/a.webp']), [])
    assert.deepEqual(
      uncovered(['packages/tokens/fonts/x/a.woff2', 'THIRD_PARTY_NOTICES.md']),
      [],
    )
  })
})
