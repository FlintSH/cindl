// Dangling references: every Markdown link, every repository path named in a
// tracked text file (code comments included) and every "docs: <page>" mention
// must point at something that exists. Part of the docs coverage gate.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { git, listFiles } from './git.mjs'
import { withoutFences } from './markdown.mjs'

export const REPOSITORY_URL = 'https://github.com/FlintSH/cindl'

const TEXT_FILE = /\.(md|ts|tsx|mts|mjs|cjs|js|jsx|json|ya?ml|css|vue|html|sh)$/
// Vendored upstream material and lockfiles describe other repositories.
const NOT_SCANNED = [/^packages\/hermes-adapter\/upstream\//, /(^|\/)pnpm-lock\.yaml$/]
// Synthetic fixture data and tests name paths in fictional workspaces or in
// the throwaway repositories they build, not in this repository.
const FICTIONAL =
  /^packages\/fixtures\/src\/|(^|\/)(test|tests|e2e)\/|\.test\.[cm]?[jt]sx?$/
// Paths into this repository. A path into a package or app that does not
// exist here (for example an upstream Hermes path) is not checked.
const REPO_PATH =
  /(?<![\w./@\\-])((?:docs\/handbook|scripts|\.github|(?:packages|apps)\/[a-z0-9-]+)(?:\/[\w@.+-]+)*\/?)/g
const DOCS_MENTION = /\bdocs:\s*([a-z0-9-]+(?:\/[a-z0-9.-]+)+)/g
const MARKDOWN_LINK =
  /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*(\S+)/gm

const lineOf = (text, index) => text.slice(0, index).split('\n').length

export function checkReferences(root) {
  // Untracked (but not ignored) files are included so new pages are checked before commit.
  const files = listFiles(root, { untracked: true })
  const exists = (path) => path !== '' && existsSync(join(root, path))
  // A path in a package's own files may be relative to that package.
  const packageRoots = files
    .filter((file) => posix.basename(file) === 'package.json')
    .map((file) => posix.dirname(file))
    .filter((dir) => dir !== '.')
  const packageOf = (file) =>
    packageRoots
      .filter((dir) => file.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0]
  // Build output and local state are named on purpose; Git ignores them. The
  // trailing-slash form matches directory-only patterns such as "dist/".
  const ignored = (path) =>
    git(root, ['check-ignore', '--no-index', path, `${path.replace(/\/+$/, '')}/`], {
      allowFailure: true,
    }) !== null
  const resolvesTo = (path) => {
    const clean = path.replace(/\/+$/, '')
    const candidates = [
      clean,
      `${clean}.md`,
      clean.replace(/\.html$/, '.md'),
      `${clean}/index.md`,
    ]
    return candidates.some((candidate) => exists(candidate))
  }
  const errors = []
  let checked = 0

  for (const file of files) {
    if (!TEXT_FILE.test(file) || NOT_SCANNED.some((pattern) => pattern.test(file)))
      continue
    if (!exists(file) || statSync(join(root, file)).size > 1024 * 1024) continue
    const text = readFileSync(join(root, file), 'utf8')
    const dir = posix.dirname(file)

    for (const match of FICTIONAL.test(file) ? [] : text.matchAll(REPO_PATH)) {
      const path = match[1].replace(/[.-]+$/, '')
      const top = path.split('/').slice(0, 2).join('/')
      if (/^(packages|apps)\//.test(path) && !exists(top)) continue
      checked++
      const own = packageOf(file)
      if (resolvesTo(path) || (own && resolvesTo(`${own}/${path}`)) || ignored(path))
        continue
      errors.push(
        `${file}:${lineOf(text, match.index)}: names ${path}, which does not exist`,
      )
    }

    for (const match of FICTIONAL.test(file) ? [] : text.matchAll(DOCS_MENTION)) {
      checked++
      if (!resolvesTo(`docs/handbook/${match[1]}`))
        errors.push(
          `${file}:${lineOf(text, match.index)}: "docs: ${match[1]}" is not a handbook page`,
        )
    }

    if (!file.endsWith('.md')) continue
    const markdown = withoutFences(text)
    for (const match of markdown.matchAll(MARKDOWN_LINK)) {
      const target = match[1] ?? match[2]
      const where = `${file}:${lineOf(markdown, match.index)}`
      let path
      if (target.startsWith(`${REPOSITORY_URL}/`)) {
        const inRepo = /^\/(?:blob|tree|edit)\/[^/]+\/([^?#]+)/.exec(
          target.slice(REPOSITORY_URL.length),
        )
        if (!inRepo) continue
        path = decodeURIComponent(inRepo[1])
      } else if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue
      else {
        const bare = decodeURIComponent(target.split('#')[0].split('?')[0])
        if (!bare) continue
        path = bare.startsWith('/')
          ? posix.join(file.startsWith('docs/handbook/') ? 'docs/handbook' : '', bare)
          : posix.normalize(posix.join(dir, bare))
        // VitePress serves docs/handbook/public at the site root, so a root link
        // from a handbook page may name a public asset (screenshots, media).
        if (
          bare.startsWith('/') &&
          file.startsWith('docs/handbook/') &&
          !resolvesTo(path)
        )
          path = posix.join('docs/handbook/public', bare)
      }
      checked++
      if (path.startsWith('..') || !resolvesTo(path))
        errors.push(`${where}: links to ${target}, which does not exist`)
    }
  }
  return { errors, checked }
}
