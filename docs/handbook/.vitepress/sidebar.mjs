import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Pages that are not part of the site (agent rules for this directory). */
export const excludedPages = ['AGENTS.md']

/** Source files that VitePress serves under another path. */
export const rewrites = {
  'architecture/decisions/README.md': 'architecture/decisions/index.md',
}

function markdownPages(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'public'].includes(entry.name) || entry.name.startsWith('.'))
      return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownPages(path, root)
    return entry.name.endsWith('.md') ? [relative(root, path).split(sep).join('/')] : []
  })
}

/**
 * The sidebar is the handbook's table of contents. Labels come from each
 * page's first heading so they never drift. Building fails if a listed page is
 * missing or a page exists that the sidebar does not list.
 */
export function buildSidebar(handbook) {
  const listed = new Set()
  const title = (file) => {
    const match = /^#\s+(.+)$/m.exec(readFileSync(join(handbook, file), 'utf8'))
    if (!match) throw new Error(`docs/handbook/${file} has no "# Title" heading`)
    return match[1].replace(/`/g, '')
  }
  const page = (file, text) => {
    if (!existsSync(join(handbook, file)))
      throw new Error(`The sidebar lists docs/handbook/${file}, which does not exist.`)
    listed.add(file)
    const target = rewrites[file] ?? file
    const link = `/${target.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`
    return { text: text ?? title(file), link }
  }
  const present = (dir, pattern) =>
    existsSync(join(handbook, dir))
      ? readdirSync(join(handbook, dir))
          .filter((name) => pattern.test(name))
          .sort()
          .map((name) => `${dir}/${name}`)
      : []
  const group = (text, items, extra = {}) => ({ text, items, ...extra })

  // Client pages are owned by the platform streams and appear once they exist.
  const clientOrder = ['web.md', 'desktop.md', 'android.md']
  const clients = present('clients', /\.md$/).sort(
    (a, b) =>
      (clientOrder.indexOf(a.slice(8)) + 1 || 99) -
      (clientOrder.indexOf(b.slice(8)) + 1 || 99),
  )

  const sidebar = [
    group('Start here', [
      page('index.md', 'Overview'),
      page('development/getting-started.md'),
    ]),
    group('Develop', [
      page('development/workflow.md'),
      page('development/quality-gates.md'),
      page('development/testing.md'),
      page('development/docs.md'),
    ]),
    ...(clients.length
      ? [
          group(
            'Clients',
            clients.map((file) => page(file)),
          ),
        ]
      : []),
    group('Operate', [page('operations/index.md')]),
    group('Reference', [
      page('reference/client-operations.md'),
      page('reference/events.md'),
      page('reference/capabilities.md'),
      page('reference/hermes-v0.22.5.md'),
      page('reference/keyboard-shortcuts.md'),
    ]),
    group('Architecture', [
      page('architecture/overview.md'),
      {
        ...page('architecture/decisions/README.md'),
        collapsed: true,
        items: present('architecture/decisions', /^\d{4}-.+\.md$/).map((file) =>
          page(file),
        ),
      },
      page('security/threat-model.md'),
    ]),
    group('Project', [
      page('project/acceptance-matrix.md'),
      page('project/pending-decisions.md'),
    ]),
  ]

  const unlisted = markdownPages(handbook).filter(
    (file) => !listed.has(file) && !excludedPages.includes(file),
  )
  if (unlisted.length)
    throw new Error(
      `Add these pages to docs/handbook/.vitepress/sidebar.mjs: ${unlisted.join(', ')}`,
    )
  return sidebar
}
