// Minimal Markdown helpers for the handbook gates. They understand exactly the
// structures the handbook uses (ATX headings, pipe tables, code spans, fenced
// code) and nothing more, so a page that drifts from them fails loudly.

const FENCE = /^(\s*)(`{3,}|~{3,})/

/** Replace fenced code blocks with blank lines (line numbers stay stable). */
export function withoutFences(markdown) {
  const out = []
  let fence = null
  for (const line of markdown.split('\n')) {
    const match = FENCE.exec(line)
    if (fence) {
      if (match && match[2][0] === fence[0] && match[2].length >= fence.length)
        fence = null
      out.push('')
    } else if (match) {
      fence = match[2]
      out.push('')
    } else out.push(line)
  }
  return out.join('\n')
}

/** Text with fenced code and inline code spans removed. */
export const prose = (markdown) => withoutFences(markdown).replace(/(`+)[^`]*?\1/g, '')

/** Contents of every inline code span in the text. */
export const codeSpans = (text) =>
  [...text.matchAll(/(`+)([^`]+?)\1/g)].map((m) => m[2].trim())

/** ATX headings outside fenced code: { level, text, line } (line is 1-based). */
export function headings(markdown) {
  return withoutFences(markdown)
    .split('\n')
    .flatMap((line, index) => {
      const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
      return match ? [{ level: match[1].length, text: match[2], line: index + 1 }] : []
    })
}

/**
 * Sections keyed by heading. Each section's body runs to the next heading of
 * the same or a higher level.
 */
export function sections(markdown) {
  const all = headings(markdown)
  const source = markdown.split('\n')
  return all.map((heading, index) => {
    const next = all.slice(index + 1).find((h) => h.level <= heading.level)
    const body = source
      .slice(heading.line, next ? next.line - 1 : source.length)
      .join('\n')
    return { ...heading, body }
  })
}

const cellsOf = (line) =>
  line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))

/** Pipe tables outside fenced code: { header: cells, rows: cells[] }. */
export function tables(markdown) {
  const found = []
  let current = null
  for (const line of withoutFences(markdown).split('\n')) {
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      current = null
      continue
    }
    const cells = cellsOf(line)
    if (!current) found.push((current = { header: cells, rows: [] }))
    else if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) current.rows.push(cells)
  }
  return found
}

/** The single code span that makes up a whole cell, or null. */
export function codeCell(cell) {
  const match = /^`([^`]+)`$/.exec(cell ?? '')
  return match ? match[1] : null
}

const begin = (name) => `<!-- BEGIN GENERATED: ${name}.`
const end = (name) => `<!-- END GENERATED: ${name} -->`

/** Content between a page's generated-block markers, or null if absent. */
export function generatedBlock(markdown, name) {
  const start = markdown.indexOf(begin(name))
  const stop = markdown.indexOf(end(name))
  if (start < 0 || stop < start) return null
  return markdown.slice(markdown.indexOf('-->', start) + 3, stop)
}

/** Replace a generated block's content; throws if the markers are missing. */
export function replaceGeneratedBlock(markdown, name, content) {
  const start = markdown.indexOf(begin(name))
  const stop = markdown.indexOf(end(name))
  if (start < 0 || stop < start)
    throw new Error(
      `missing markers "${begin(name)} ... -->" and "${end(name)}" (add both, then regenerate)`,
    )
  const open = markdown.indexOf('-->', start) + 3
  return `${markdown.slice(0, open)}\n\n${content.trim()}\n\n${markdown.slice(stop)}`
}

export const generatedMarkers = { begin, end }
