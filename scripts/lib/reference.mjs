// Generated handbook reference blocks. The tables between the GENERATED
// markers are rendered from source and formatted with the repository's
// Prettier config, so `pnpm format:check` and the drift check always agree.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { replaceGeneratedBlock } from './markdown.mjs'

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const code = (text) => `\`${text}\``
const kbd = (keys) =>
  keys
    .map((key) => `<kbd>${cell(key.replace(/&/g, '&amp;').replace(/</g, '&lt;'))}</kbd>`)
    .join(' + ')

function table(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows]
    .map((row) => `| ${row.map(cell).join(' | ')} |`)
    .join('\n')
}

export const generatedBlocks = [
  {
    name: 'client-operations',
    page: 'docs/handbook/reference/client-operations.md',
    source: 'packages/contracts/src/ops.ts',
    render: ({ operations }) =>
      table(
        ['Operation', 'Requires capability', 'Changes state', 'Summary'],
        operations.map((op) => [
          code(op.name),
          op.capability ? code(op.capability) : 'none',
          op.mutates ? 'yes' : 'no',
          op.summary,
        ]),
      ),
  },
  {
    name: 'events',
    page: 'docs/handbook/reference/events.md',
    source: 'packages/contracts/src/events.ts',
    render: ({ events }) =>
      table(
        ['Event', 'Payload'],
        events.map((event) => [
          `[${code(event.type)}](#${event.type.replace(/\./g, '-')})`,
          event.fields
            .map(
              (field) =>
                `${code(field.name)}: ${field.optional ? 'optional ' : ''}${field.description}`,
            )
            .join('; '),
        ]),
      ),
  },
  {
    name: 'keyboard-shortcuts',
    page: 'docs/handbook/reference/keyboard-shortcuts.md',
    source: 'apps/web/src/shortcuts.ts',
    render: ({ shortcuts }) =>
      table(
        ['Action', 'Windows and Linux', 'macOS', 'While typing', 'ID'],
        shortcuts.map((shortcut) => [
          shortcut.label,
          kbd(shortcut.windows),
          kbd(shortcut.mac),
          shortcut.global ? 'yes' : 'no',
          code(shortcut.id),
        ]),
      ),
  },
]

/** Format Markdown exactly as `prettier --write` would for that path. */
export async function formatMarkdown(path, text) {
  let prettier
  try {
    prettier = await import('prettier')
  } catch (error) {
    throw new Error(
      'prettier is not installed; run pnpm install --frozen-lockfile at the repository root',
      { cause: error },
    )
  }
  const options = (await prettier.resolveConfig(path)) ?? {}
  return prettier.format(text, { ...options, filepath: path })
}

/**
 * Current and expected content for every generated page. A page whose
 * markers are missing is reported with `error` instead of `expected`.
 */
export async function renderGeneratedPages(root, sources) {
  const pages = new Map()
  for (const block of generatedBlocks) {
    const path = resolve(root, block.page)
    let entry = pages.get(path)
    if (!entry) {
      let current
      try {
        current = await readFile(path, 'utf8')
      } catch {
        entry = { page: block.page, path, error: 'page is missing' }
        pages.set(path, entry)
        continue
      }
      entry = { page: block.page, path, current, draft: current, blocks: [] }
      pages.set(path, entry)
    }
    if (entry.error) continue
    try {
      entry.draft = replaceGeneratedBlock(entry.draft, block.name, block.render(sources))
      entry.blocks.push(block)
    } catch (error) {
      entry.error = `${block.name}: ${error.message}`
    }
  }
  for (const entry of pages.values())
    if (!entry.error) entry.expected = await formatMarkdown(entry.path, entry.draft)
  return [...pages.values()]
}
