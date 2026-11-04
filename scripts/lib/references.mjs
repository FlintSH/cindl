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

// The handbook site (VitePress 1.6.4) names heading anchors with this rule
// (vitepress/dist/node: `slugify`). GitHub's rule differs: for "Hermes's" it
// drops the apostrophe where the site writes a hyphen. Links between handbook
// pages are checked against the site's anchors, which `pnpm docs:build` serves.
// eslint-disable-next-line no-control-regex -- the site's rule strips control characters
const CONTROL = /[\u0000-\u001f]/g
const SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const COMBINING = /[\u0300-\u036F]/g
export const siteSlug = (text) =>
  text
    .normalize('NFKD')
    .replace(COMBINING, '')
    .replace(CONTROL, '')
    .replace(SPECIAL, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()

/** The anchors the handbook site gives a page's headings. */
export function headingAnchors(markdown) {
  const anchors = new Set()
  const seen = new Map()
  for (const match of withoutFences(markdown).matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const custom = /\s*\{#([\w-]+)\}$/.exec(match[1])
    if (custom) {
      anchors.add(custom[1])
      continue
    }
    // The rendered text: code keeps its content, links their text; markup goes.
    const text = match[1]
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/(\*{1,3}|_{1,3})(\S(?:.*?\S)?)\1/g, '$2')
    const slug = siteSlug(text)
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    // Later headings with the same text get -1, -2, ... (markdown-it-anchor).
    anchors.add(count ? `${slug}-${count}` : slug)
  }
  return anchors
}

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
  const anchorsOf = new Map()
  /** The site's anchors of a handbook page, or undefined when `path` is not one. */
  const pageAnchors = (path) => {
    const clean = path.replace(/\/+$/, '')
    const page = [
      clean.endsWith('.md') ? clean : undefined,
      `${clean}.md`,
      clean.replace(/\.html$/, '.md'),
      `${clean}/index.md`,
    ].find(
      (candidate) =>
        candidate?.startsWith('docs/handbook/') &&
        candidate.endsWith('.md') &&
        exists(candidate) &&
        statSync(join(root, candidate)).isFile(),
    )
    if (!page) return undefined
    if (!anchorsOf.has(page))
      anchorsOf.set(page, headingAnchors(readFileSync(join(root, page), 'utf8')))
    return anchorsOf.get(page)
  }
  /** A link between handbook pages must name an anchor the site gives its target. */
  const checkAnchor = (file, path, target, where) => {
    const fragment = target.includes('#') ? target.slice(target.indexOf('#') + 1) : ''
    if (!fragment || !file.startsWith('docs/handbook/')) return
    const anchors = pageAnchors(path)
    if (!anchors) return
    checked++
    if (!anchors.has(decodeURIComponent(fragment)))
      errors.push(
        `${where}: links to ${target}, but the handbook site gives that page no #${fragment} anchor`,
      )
  }

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
      } else if (target.startsWith('#')) {
        checkAnchor(file, file, target, where)
        continue
      } else if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue
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
      else checkAnchor(file, path, target, where)
    }
  }
  return { errors, checked }
}
