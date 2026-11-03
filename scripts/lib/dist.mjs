// Rules for the production-output gate (scripts/check-dist.mjs). A production
// build must not carry the synthetic demo scenario, and its source maps must
// not leak where it was built.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

/** Synthetic data lives here; nothing from it may reach a production build. */
export const FIXTURES_SOURCE = 'packages/fixtures/src'

/**
 * Markers that must never appear in production output, beyond those derived
 * from the fixture literals. Each must occur in the fixtures source, so the
 * list cannot silently go stale.
 */
export const EXTRA_MARKERS = ['Lumen & Kiln', 'hermes.synthetic.invalid', 'demo-main']

const MIN_MARKER_LENGTH = 8
const TEXT_OUTPUT = /\.(html?|m?js|cjs|css|map|json|txt|svg|webmanifest|xml)$/i

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/** Every string literal (and template text) in TypeScript source, cooked. */
function literalsOf(ts, path, text) {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  )
  const found = []
  const visit = (node) => {
    const isSpecifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      found.push(node.text)
    ts.forEachChild(node, (child) => {
      if (isSpecifier && child === node.moduleSpecifier) return
      visit(child)
    })
  }
  visit(file)
  return found
}

/**
 * Lines of fixture literals that identify the synthetic scenario: at least 8
 * ASCII characters, not a bare word, and absent from every production source
 * file, so a match in build output can only have come from the fixtures.
 */
export async function demoMarkers(root) {
  let ts
  try {
    ts = (await import('typescript')).default
  } catch (error) {
    throw new Error('typescript is not installed; run pnpm install --frozen-lockfile', {
      cause: error,
    })
  }
  const fixturesDir = join(root, FIXTURES_SOURCE)
  if (!existsSync(fixturesDir)) throw new Error(`${FIXTURES_SOURCE} does not exist`)
  const fixtureFiles = walk(fixturesDir).filter((file) => /\.tsx?$/.test(file))
  const fixtureText = fixtureFiles.map((file) => readFileSync(file, 'utf8'))
  const production = ['apps', 'packages']
    .filter((dir) => existsSync(join(root, dir)))
    .flatMap((dir) =>
      readdirSync(join(root, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, dir, entry.name, 'src'))
        .filter((src) => existsSync(src) && relative(root, src) !== FIXTURES_SOURCE),
    )
    .flatMap((src) => walk(src))
    .filter((file) => /\.(tsx?|jsx?|mjs|css)$/.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')

  const candidates = new Set()
  fixtureFiles.forEach((file, index) => {
    for (const literal of literalsOf(ts, file, fixtureText[index]))
      for (const line of literal.split('\n')) {
        const value = line.trim()
        if (
          value.length >= MIN_MARKER_LENGTH &&
          /^[\x20-\x7e]+$/.test(value) &&
          !/['"`\\]/.test(value) &&
          /[\s\-./:@&0-9]/.test(value)
        )
          candidates.add(value)
      }
  })
  const markers = [...candidates].filter((value) => !production.includes(value))
  const errors = []
  for (const marker of EXTRA_MARKERS) {
    if (!fixtureText.some((text) => text.includes(marker)))
      errors.push(
        `EXTRA_MARKERS: "${marker}" no longer occurs in ${FIXTURES_SOURCE}; update the list`,
      )
    else if (production.includes(marker))
      errors.push(
        `EXTRA_MARKERS: "${marker}" also occurs in production source, so it cannot be a marker`,
      )
    else if (!markers.includes(marker)) markers.push(marker)
  }
  if (!markers.length)
    errors.push(`no demo markers could be derived from ${FIXTURES_SOURCE}`)
  return { markers, errors }
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|file:|\\\\)/

/** Check production output directories; returns problems found. */
export function checkOutputs(root, dirs, markers) {
  const errors = []
  const leaks = [root.replace(/\/$/, ''), homedir()].filter((path) => path.length > 4)
  let files = 0
  let maps = 0
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      errors.push(`${dir}: no build output here; build it first`)
      continue
    }
    if (/(^|\/)dist-demo(\/|$)/.test(relative(root, dir)))
      errors.push(`${relative(root, dir)}: is a demo build; check production output only`)
    for (const file of walk(dir)) {
      const name = relative(root, file)
      if (!TEXT_OUTPUT.test(file)) continue
      files++
      const text = readFileSync(file, 'utf8')
      const found = markers.filter((marker) => text.includes(marker))
      if (found.length)
        errors.push(
          `${name}: contains synthetic demo data (${found
            .slice(0, 3)
            .map((marker) => `"${marker}"`)
            .join(', ')}${found.length > 3 ? ` and ${found.length - 3} more` : ''})`,
        )
      for (const path of leaks)
        if (text.includes(path))
          errors.push(`${name}: contains the build machine path ${path}`)
      if (!file.endsWith('.map')) continue
      maps++
      let map
      try {
        map = JSON.parse(text)
      } catch {
        errors.push(`${name}: source map is not valid JSON`)
        continue
      }
      if (map.sourceRoot && ABSOLUTE.test(map.sourceRoot))
        errors.push(`${name}: absolute sourceRoot ${map.sourceRoot}`)
      for (const source of map.sources ?? []) {
        if (ABSOLUTE.test(source)) errors.push(`${name}: absolute source path ${source}`)
        if (source.includes('packages/fixtures/') || source.includes('@cindl/fixtures'))
          errors.push(`${name}: bundles the synthetic fixtures (${source})`)
      }
    }
  }
  return { errors, files, maps }
}
