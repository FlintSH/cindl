// Rules for the per-commit docs-impact gate (scripts/check-docs-impact.mjs).
import { git, lines, nulSeparated } from './git.mjs'

/** The gate applies to commits that contain this file's first version. */
export const POLICY_FILE = 'scripts/check-docs-impact.mjs'

/** Documentation areas, by the persona that reads them. */
export const DOCS = {
  user: /^docs\/handbook\/(clients|guide)\/|^docs\/handbook\/reference\/keyboard-shortcuts\.md$|^DESIGN\.md$/,
  operator:
    /^docs\/handbook\/(operations|security)\/|^docs\/handbook\/project\/pending-decisions\.md$|^SECURITY\.md$/,
  integration: /^docs\/handbook\/(reference|architecture)\//,
  contributor: /^docs\/handbook\/development\/|(^|\/)AGENTS\.md$|^CONTRIBUTING\.md$/,
}
const ANY_DOC =
  /^docs\/handbook\/.*\.md$|^(README|AGENTS|CONTRIBUTING|DESIGN|SECURITY)\.md$/

/** Paths that are never a code change: docs and their media, tests, Git hygiene. */
export const EXEMPT = [
  /\.md$/i,
  /^docs\/handbook\/public\//,
  /(^|\/)(test|tests|e2e|__tests__)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$|dependabot\.ya?ml$)/,
  /(^|\/)\.gitignore$|^(\.gitattributes|\.editorconfig|\.prettierignore|LICENSE)$/,
]

/**
 * Code areas and the documentation that must change in the same commit. The
 * first matching rule owns a path; paths no rule owns need some handbook page.
 */
export const RULES = [
  {
    area: 'client contract',
    code: /^packages\/contracts\/(src|scripts)\//,
    docs: [DOCS.integration],
  },
  {
    area: 'Hermes transport',
    code: /^packages\/hermes-adapter\/(src|scripts|upstream)\//,
    docs: [DOCS.integration, DOCS.operator],
  },
  {
    area: 'client state',
    code: /^packages\/client-(core|react)\/src\//,
    docs: [DOCS.integration, DOCS.user],
  },
  {
    area: 'design tokens and fonts',
    code: /^packages\/tokens\/(src|scripts|fonts|generated)\//,
    docs: [
      DOCS.user,
      /^THIRD_PARTY_NOTICES\.md$/,
      /^docs\/handbook\/architecture\/decisions\/0010-/,
    ],
  },
  {
    area: 'synthetic fixtures',
    code: /^packages\/fixtures\/src\//,
    docs: [DOCS.contributor, /^docs\/handbook\/architecture\/decisions\/0011-/],
  },
  { area: 'web client', code: /^apps\/web\//, docs: [DOCS.user] },
  {
    area: 'desktop client',
    code: /^apps\/desktop\//,
    docs: [/^docs\/handbook\/clients\/desktop\.md$/, DOCS.operator],
  },
  {
    area: 'Android client',
    code: /^apps\/android\//,
    docs: [/^docs\/handbook\/clients\/android\.md$/, DOCS.operator],
  },
  {
    area: 'handbook site',
    code: /^docs\/handbook\/(\.vitepress\/|package\.json$|pnpm-workspace\.yaml$|pnpm-lock\.yaml$)/,
    docs: [DOCS.contributor],
  },
  {
    area: 'tooling and CI',
    code: /^(scripts|\.github)\/|^[^/]+$|^(packages|apps)\/[^/]+\/[^/]+$/,
    docs: [DOCS.contributor],
  },
]
const OTHER = { area: 'other source', code: /$^/, docs: [ANY_DOC] }

// Words that say nothing on their own; a rationale needs at least one other word.
const GENERIC = new Set(
  `a an and are as at be behavior behaviour change changed changes chore clean cleanup code
  doc docs documentation documented fix fixed fixes for impact in internal is it just minor
  misc n na necessary needed no none not nothing obvious of on only refactor refactoring
  required same see simple small the this to trivial trivially typo typos update updated
  updates user users visible wip with`.split(/\s+/),
)

/** Why a Docs-Impact trailer value is unacceptable, or null when it is fine. */
export function trailerProblem(value) {
  const match = /^none\s+[-–—]\s+(.*)$/is.exec(value.trim())
  if (!match) return `"${value.trim()}" does not read "none - <rationale>"`
  const rationale = match[1].trim()
  if (rationale.length < 20)
    return `the rationale "${rationale}" has ${rationale.length} characters; at least 20 are required`
  const words = rationale.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (words.every((word) => GENERIC.has(word)))
    return `the rationale "${rationale}" is generic; say what changed and why no page describes it`
  return null
}

/** Code areas a set of changed paths touches without the matching docs change. */
export function uncovered(files) {
  const areas = new Map()
  for (const file of files) {
    if (EXEMPT.some((pattern) => pattern.test(file))) continue
    const rule = RULES.find((candidate) => candidate.code.test(file)) ?? OTHER
    areas.set(rule, [...(areas.get(rule) ?? []), file])
  }
  return [...areas]
    .filter(([rule]) => !files.some((file) => rule.docs.some((doc) => doc.test(file))))
    .map(([rule, code]) => ({ area: rule.area, code, docs: rule.docs }))
}

const DEPENDABOT = /^\d+\+dependabot\[bot\]@users\.noreply\.github\.com$/
const DEPENDENCY_FILE =
  /(^|\/)(package\.json|pnpm-lock\.yaml)$|^\.github\/workflows\/[^/]+\.ya?ml$/

function commitOf(root, rev, flag) {
  if (!rev) throw new Error(`pass ${flag} <commit>`)
  if (/^0+$/.test(rev))
    throw new Error(
      `${flag} ${rev} is the null commit (a new branch); pass the merge base instead`,
    )
  const sha = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    allowFailure: true,
  })
  if (!sha)
    throw new Error(
      `${flag} ${rev} is not a commit in this clone; fetch full history (actions/checkout fetch-depth: 0)`,
    )
  return sha.trim()
}

export function checkDocsImpact(root, base, head = 'HEAD') {
  const baseSha = commitOf(root, base, '--base')
  const headSha = commitOf(root, head, '--head')
  const [adoption] = lines(
    git(root, [
      'log',
      '--format=%H',
      '--diff-filter=A',
      '--reverse',
      headSha,
      '--',
      POLICY_FILE,
    ]),
  )
  const commits = lines(
    git(root, ['rev-list', '--reverse', '--no-merges', `${baseSha}..${headSha}`]),
  )
  const errors = []
  let checked = 0
  let explained = 0
  let dependabot = 0
  for (const commit of commits) {
    const adopted =
      adoption !== undefined &&
      git(root, ['merge-base', '--is-ancestor', adoption, commit], {
        allowFailure: true,
      }) !== null
    if (!adopted) continue
    checked++
    const show = (format) => git(root, ['log', '-1', `--format=${format}`, commit])
    const label = `${commit.slice(0, 10)} "${show('%s').trim()}"`
    const files = nulSeparated(
      git(root, [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '-r',
        '-z',
        commit,
      ]),
    )
    const trailers = show('%(trailers:key=Docs-Impact,valueonly,unfold,separator=%x00)')
      .split('\0')
      .map((value) => value.trim())
      .filter(Boolean)
    if (trailers.length > 1) {
      errors.push(`${label}: has ${trailers.length} Docs-Impact trailers; keep one`)
      continue
    }
    const problem = trailers.length ? trailerProblem(trailers[0]) : null
    if (problem) {
      errors.push(`${label}: Docs-Impact trailer rejected: ${problem}`)
      continue
    }
    const gaps = uncovered(files)
    if (!gaps.length) continue
    if (trailers.length) {
      explained++
      continue
    }
    if (
      DEPENDABOT.test(show('%ae').trim()) &&
      files.every((file) => DEPENDENCY_FILE.test(file))
    ) {
      dependabot++
      continue
    }
    const misplaced = /^Docs-Impact:/im.test(show('%B'))
      ? ' It has a "Docs-Impact:" line, but not in the final paragraph, so Git does not read it as a trailer.'
      : ''
    errors.push(
      [
        `${label}: documentation was not updated in this commit.${misplaced}`,
        ...gaps.map((gap) => {
          const more = gap.code.length > 3 ? ` (+${gap.code.length - 3} more)` : ''
          const docs = gap.docs.map((doc) => doc.source).join(' or ')
          return `    ${gap.area}: ${gap.code.slice(0, 3).join(', ')}${more} changed; expected a change matching ${docs}`
        }),
        '    Update those pages in this commit. If nothing a reader relies on changed, end the',
        '    message with "Docs-Impact: none - <why no page changes, at least 20 characters>".',
      ].join('\n'),
    )
  }
  const skipped = commits.length - checked
  let summary = `${checked} commit(s) in ${baseSha.slice(0, 10)}..${headSha.slice(0, 10)} checked (${explained} with a Docs-Impact rationale, ${dependabot} Dependabot dependency update(s))`
  if (skipped)
    summary += `; ${skipped} commit(s) predate ${POLICY_FILE} and are not checked`
  summary +=
    '. Paths cannot prove completeness: review the affected pages as AGENTS.md describes.'
  return { errors, summary }
}
