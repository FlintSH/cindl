#!/usr/bin/env node
// Checks the built handbook (docs/handbook/.vitepress/dist): every local link,
// anchor and asset resolves; no page or stylesheet loads anything from another
// origin (no CDN fonts, scripts or trackers); every page is reachable from
// another page; and every page carries the build's Git provenance.
// Usage: node scripts/check-docs-build.mjs [--dist <dir>] [--base /path/]
//          [--root <repository>] [--repo-url https://github.com/<owner>/<repo>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRoot, report } from './lib/git.mjs'

const { values } = parseArgs({
  options: {
    dist: { type: 'string' },
    base: { type: 'string' },
    root: { type: 'string' },
    'repo-url': { type: 'string' },
  },
})
const root = resolve(values.root ?? defaultRoot)
const dist = resolve(values.dist ?? join(root, 'docs/handbook/.vitepress/dist'))
const base = values.base ?? process.env.DOCS_BASE ?? '/'
const repoUrl = (values['repo-url'] ?? 'https://github.com/FlintSH/cindl').replace(
  /\/$/,
  '',
)

const errors = new Set()
const fail = (message) => errors.add(message)

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

const entities = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' }
const decode = (value) => value.replace(/&(?:amp|#39|quot|lt|gt);/g, (e) => entities[e])
const isExternal = (url) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)

/** Attributes of every tag of interest in an HTML document. */
function tagsOf(html) {
  const tags = []
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const attributes = {}
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    for (const attr of match[2].matchAll(pattern))
      attributes[attr[1].toLowerCase()] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '')
    tags.push({ name: match[1].toLowerCase(), attributes })
  }
  return tags
}

// Attributes that make the browser fetch something, by tag.
const RESOURCE_ATTRIBUTES = {
  script: ['src'],
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  iframe: ['src'],
  embed: ['src'],
  object: ['data'],
  image: ['href'],
  use: ['href'],
}
// <link> relations that only describe the page and fetch nothing.
const NON_LOADING_RELS = new Set([
  'canonical',
  'alternate',
  'author',
  'license',
  'me',
  'help',
])

if (!existsSync(join(dist, 'index.html'))) {
  report(
    'docs build',
    [`${dist} has no index.html; build first: pnpm --dir docs/handbook build`],
    '',
  )
  process.exit()
}
if (!/^\/(?:[^/]+\/)*$/.test(base)) fail(`base must begin and end with "/" (got ${base})`)

const files = new Set(walk(dist))
const pages = [...files].filter((file) => file.endsWith('.html'))
const html = new Map(pages.map((page) => [page, readFileSync(page, 'utf8')]))
const inbound = new Map(pages.map((page) => [page, 0]))
const stamps = new Map(pages.map((page) => [page, { meta: [], stamp: [] }]))
let links = 0
let anchors = 0
let assets = 0

/** Resolve a same-site URL to a file in dist, or report why it cannot be. */
function target(from, url, label) {
  const [beforeHash, hash] = url.split('#')
  const pathname = decodeURIComponent(beforeHash.split('?')[0])
  if (pathname.startsWith('/') && !pathname.startsWith(base)) {
    fail(`${label}: ${url} is outside the site base ${base}`)
    return null
  }
  let file = !pathname
    ? from
    : pathname.startsWith('/')
      ? join(dist, pathname.slice(base.length))
      : resolve(dirname(from), pathname)
  if (pathname.endsWith('/')) file = join(file, 'index.html')
  if (!files.has(file) && !extname(file) && files.has(`${file}.html`))
    file = `${file}.html`
  if (!files.has(file)) {
    fail(`${label}: ${url} does not exist in the build`)
    return null
  }
  return { file, hash }
}

function checkRepositoryLink(url, label) {
  const match = /^\/(?:blob|tree|edit)\/[^/]+\/([^?#]+)/.exec(url.slice(repoUrl.length))
  if (!match) return
  const path = decodeURIComponent(match[1])
  if (!existsSync(join(root, path)))
    fail(`${label}: ${url} names ${path}, which does not exist`)
}

for (const [page, source] of html) {
  const label = relative(dist, page)
  for (const { name, attributes } of tagsOf(source)) {
    if (name === 'meta' && attributes.name === 'cindl:commit')
      stamps.get(page).meta.push(attributes.content)
    if ('data-build-stamp' in attributes)
      stamps.get(page).stamp.push(attributes['data-commit'])
    const loading = [...(RESOURCE_ATTRIBUTES[name] ?? [])]
    if (name === 'link' && attributes.href) {
      const rels = (attributes.rel ?? '').toLowerCase().split(/\s+/)
      if (!rels.every((rel) => NON_LOADING_RELS.has(rel))) loading.push('href')
    }
    for (const attribute of loading) {
      const value = attributes[attribute]
      if (!value) continue
      const urls =
        attribute === 'srcset'
          ? value.split(',').map((part) => part.trim().split(/\s+/)[0])
          : [value]
      for (const url of urls) {
        if (url.startsWith('data:')) continue
        if (isExternal(url)) {
          fail(`${label}: <${name} ${attribute}> loads ${url} from another origin`)
          continue
        }
        assets++
        target(page, url, label)
      }
    }
    if (name !== 'a' || attributes.href === undefined) continue
    const href = attributes.href
    if (/^javascript:/i.test(href)) fail(`${label}: javascript: link ${href}`)
    if (href.startsWith(`${repoUrl}/`)) checkRepositoryLink(href, label)
    if (isExternal(href)) continue
    links++
    const resolved = target(page, href, label)
    if (!resolved) continue
    if (resolved.file !== page && inbound.has(resolved.file))
      inbound.set(resolved.file, inbound.get(resolved.file) + 1)
    if (resolved.hash && resolved.file.endsWith('.html')) {
      anchors++
      const id = decodeURIComponent(resolved.hash)
      if (!html.get(resolved.file)?.includes(`id="${id}"`))
        fail(`${label}: ${href} points to a missing anchor`)
    }
  }
}

// Stylesheets: fonts and images must be local and present.
for (const file of [...files].filter((f) => f.endsWith('.css'))) {
  const label = relative(dist, file)
  const css = readFileSync(file, 'utf8')
  for (const match of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g))
    if (isExternal(match[1]))
      fail(`${label}: @import ${match[1]} loads from another origin`)
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const url = match[2].trim()
    if (url.startsWith('data:') || url.startsWith('#')) continue
    if (isExternal(url)) {
      fail(`${label}: url(${url}) loads from another origin`)
      continue
    }
    assets++
    target(file, url, label)
  }
}

// Reachability: every page except the home page and 404 is linked from another page.
for (const [page, count] of inbound) {
  const name = relative(dist, page)
  if (count === 0 && name !== 'index.html' && name !== '404.html')
    fail(`${name}: no other page links here (add it to the sidebar or link to it)`)
}

// Provenance: build-info.json is valid and every page states the same commit.
let info = null
try {
  info = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8'))
} catch {
  fail('build-info.json is missing or not JSON')
}
if (info) {
  const sources = ['git', 'GITHUB_SHA', 'unavailable']
  if (info.commit !== null && !/^[0-9a-f]{40}$/.test(info.commit ?? ''))
    fail('build-info.json: commit must be a full SHA or null')
  if (info.shortCommit !== (info.commit ? info.commit.slice(0, 12) : null))
    fail('build-info.json: shortCommit does not match commit')
  if (![true, false, null].includes(info.dirty))
    fail('build-info.json: dirty must be true, false or null')
  if (Number.isNaN(Date.parse(info.builtAt ?? '')))
    fail('build-info.json: builtAt is not a date')
  if (!sources.includes(info.source))
    fail(`build-info.json: source must be one of ${sources.join(', ')}`)
  const commit = info.commit ?? 'unavailable'
  for (const [page, { meta, stamp }] of stamps) {
    const name = relative(dist, page)
    if (meta.length !== 1 || meta[0] !== commit)
      fail(`${name}: needs exactly one <meta name="cindl:commit" content="${commit}">`)
    if (name !== '404.html' && (stamp.length !== 1 || stamp[0] !== commit))
      fail(`${name}: needs exactly one build stamp for commit ${commit}`)
  }
}

const size = [...files].reduce((total, file) => total + statSync(file).size, 0)
report(
  'docs build',
  [...errors],
  `${pages.length} pages, ${links} local links (${anchors} with anchors) and ${assets} assets resolve; nothing loads from another origin; every page is reachable and stamped with ${info?.shortCommit ?? 'no commit'}${info?.dirty ? ' (uncommitted changes)' : ''}. Output ${(size / 1e6).toFixed(1)} MB.`,
)
