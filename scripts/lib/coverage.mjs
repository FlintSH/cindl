// Coverage rules for the handbook (scripts/check-docs-coverage.mjs).
import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import {
  codeCell,
  codeSpans,
  prose,
  sections,
  tables,
  withoutFences,
} from './markdown.mjs'
import { renderGeneratedPages } from './reference.mjs'
import { checkReferences } from './references.mjs'
import { loadSources } from './sources.mjs'

const pages = {
  capabilities: 'docs/handbook/reference/capabilities.md',
  events: 'docs/handbook/reference/events.md',
  hermes: 'docs/handbook/reference/hermes-v0.22.5.md',
}
const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX)\b|lorem ipsum|coming soon/i

/** Compare documented names with source names, both ways. */
function compare(errors, where, what, source, documented) {
  const known = new Set(source)
  const seen = new Set(documented)
  for (const name of source)
    if (!seen.has(name)) errors.push(`${where}: ${what} \`${name}\` is not documented`)
  for (const name of seen)
    if (!known.has(name))
      errors.push(`${where}: documents \`${name}\`, which is not a current ${what}`)
}

/**
 * Names from the first column of tables headed `heading`. Every row must name
 * one item in a code span and fill in every cell.
 */
function tableNames(errors, where, markdown, heading) {
  const matching = tables(markdown).filter((t) => heading.test(t.header[0] ?? ''))
  if (!matching.length)
    errors.push(`${where}: no table with a "${heading.source}" column`)
  return matching.flatMap(({ rows }) =>
    rows.flatMap((cells) => {
      const name = codeCell(cells[0])
      if (!name) {
        errors.push(`${where}: row "${cells[0]}" must name one item in a code span`)
        return []
      }
      if (cells.some((cell) => cell === ''))
        errors.push(`${where}: the row for \`${name}\` has an empty cell`)
      return [name]
    }),
  )
}

async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => !['node_modules', '.vitepress', 'public'].includes(entry.name))
      .map((entry) =>
        entry.isDirectory()
          ? markdownFiles(resolve(dir, entry.name))
          : entry.name.endsWith('.md')
            ? [resolve(dir, entry.name)]
            : [],
      ),
  )
  return nested.flat()
}

export async function checkCoverage(root) {
  const errors = []
  const sources = await loadSources(root)
  const read = async (path) => {
    try {
      return await readFile(resolve(root, path), 'utf8')
    } catch {
      errors.push(`${path}: page is missing`)
      return ''
    }
  }

  // Capabilities: one table row per capability id (content owned by the
  // transport stream; this only checks that each id is present and current).
  const capabilities = await read(pages.capabilities)
  compare(
    errors,
    pages.capabilities,
    'capability',
    sources.capabilityIds,
    tableNames(errors, pages.capabilities, capabilities, /^capability$/i),
  )

  // Events: a described `### \`type\`` section each; error codes: a table row each.
  const events = await read(pages.events)
  const eventSections = sections(events).filter((s) => s.level === 3 && codeCell(s.text))
  for (const section of eventSections)
    if (prose(section.body).replace(/\s+/g, ' ').trim().length < 40)
      errors.push(`${pages.events}: \`${codeCell(section.text)}\` needs a description`)
  compare(
    errors,
    pages.events,
    'event type',
    sources.events.map((event) => event.type),
    eventSections.map((section) => codeCell(section.text)),
  )
  const errorSection = sections(events).find((s) => /^error codes$/i.test(s.text))
  if (!errorSection) errors.push(`${pages.events}: missing the "Error codes" section`)
  compare(
    errors,
    pages.events,
    'error code',
    sources.errorCodes,
    errorSection ? tableNames(errors, pages.events, errorSection.body, /^code$/i) : [],
  )

  // Hermes reference: every pinned upstream name and REST endpoint appears.
  const hermes = new Set(codeSpans(withoutFences(await read(pages.hermes))))
  for (const [kind, names] of Object.entries(sources.upstream))
    for (const name of names)
      if (!hermes.has(name))
        errors.push(`${pages.hermes}: ${kind} \`${name}\` is missing`)
  for (const endpoint of sources.restEndpoints) {
    const route = `${endpoint.method} ${endpoint.path}`
    if (!hermes.has(route))
      errors.push(`${pages.hermes}: REST endpoint \`${route}\` is missing`)
  }

  // Generated tables (client operations, event payloads, keyboard shortcuts).
  for (const page of await renderGeneratedPages(root, sources)) {
    if (page.error) errors.push(`${page.page}: ${page.error}`)
    else if (page.current !== page.expected)
      errors.push(
        `${page.page}: generated tables are out of date with ${page.blocks
          .map((block) => block.source)
          .join(', ')}; run node scripts/generate-docs-reference.mjs`,
      )
  }

  // No placeholder pages anywhere in the handbook (code spans and blocks are exempt).
  for (const file of await markdownFiles(resolve(root, 'docs/handbook'))) {
    const match = PLACEHOLDER.exec(prose(await readFile(file, 'utf8')))
    if (match)
      errors.push(`${relative(root, file)}: placeholder text "${match[0]}" outside code`)
  }

  // Links and repository paths named anywhere point at files that exist.
  const references = checkReferences(root)
  errors.push(...references.errors)

  const counts = [
    `${sources.capabilityIds.length} capabilities`,
    `${sources.operations.length} client operations`,
    `${sources.events.length} events`,
    `${sources.errorCodes.length} error codes`,
    `${sources.shortcuts.length} keyboard shortcuts`,
    `${Object.values(sources.upstream).flat().length} pinned Hermes names`,
    `${sources.restEndpoints.length} REST endpoints`,
  ]
  return {
    errors,
    summary: `the handbook covers ${counts.join(', ')}; ${references.checked} links and file references resolve.`,
  }
}
