// Rules for the build-output gate (scripts/check-dist.mjs), per ADR 0011:
// real-flavour outputs carry no synthetic fixture records; demo-flavour
// outputs always carry the demo label. Both must not leak where they were
// built. Markers and labels come from the packages that own them.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|file:|\\\\)/
// Compressed containers hide their contents from a byte search.
const COMPRESSED = /\.(zip|apk|aab|ipa|gz|tgz|xz|br|zst|7z|dmg|msi|exe|appimage)$/i

/** Load a workspace package's export by subpath, as Node would resolve it. */
async function packageExport(root, dir, subpath) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  const target = manifest.exports?.[subpath]
  if (typeof target !== 'string')
    throw new Error(`${dir}/package.json does not export "${subpath}"`)
  try {
    return await import(pathToFileURL(join(root, dir, target)).href)
  } catch (error) {
    throw new Error(
      `could not load ${manifest.name}${subpath.slice(1)} (${error.message}); run pnpm install --frozen-lockfile`,
      { cause: error },
    )
  }
}

/**
 * Fixture markers (@cindl/fixtures/markers) and the required demo label
 * (@cindl/contracts). Fails closed: an empty or malformed list is an error.
 */
export async function loadMarkers(root) {
  const { SYNTHETIC_FIXTURE_MARKERS: markers } = await packageExport(
    root,
    'packages/fixtures',
    './markers',
  )
  const { SYNTHETIC_DEMO_LABEL: label, SYNTHETIC_DEMO_NOTICE: notice } =
    await packageExport(root, 'packages/contracts', '.')
  const errors = []
  if (
    !Array.isArray(markers) ||
    !markers.length ||
    markers.some((m) => typeof m !== 'string' || !m)
  )
    errors.push(
      '@cindl/fixtures/markers: SYNTHETIC_FIXTURE_MARKERS must be a non-empty list of strings',
    )
  for (const [name, value] of [
    ['SYNTHETIC_DEMO_LABEL', label],
    ['SYNTHETIC_DEMO_NOTICE', notice],
  ])
    if (typeof value !== 'string' || !value)
      errors.push(`@cindl/contracts: ${name} is missing`)
  return { markers: errors.length ? [] : [...markers], labels: { label, notice }, errors }
}

function filesOf(path) {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesOf(join(path, entry.name)) : [join(path, entry.name)],
  )
}

/**
 * Check build outputs. `outputs` is a list of { path, flavour: 'real' | 'demo' };
 * a path may be a folder or a single packaged file (for example app.asar).
 */
export function checkOutputs(root, outputs, { markers, labels }) {
  const errors = []
  const leaks = [resolve(root), homedir()].filter((path) => path.length > 4)
  let files = 0
  let maps = 0
  for (const { path, flavour } of outputs) {
    const name = relative(root, path) || path
    if (!existsSync(path)) {
      errors.push(`${name}: no build output here; build it first`)
      continue
    }
    if (flavour === 'real' && /(^|[/\\])dist-demo([/\\]|$)/.test(name))
      errors.push(`${name}: is a demo build; pass it with --demo`)
    const seen = { label: false, notice: false }
    const found = filesOf(path)
    if (!found.length) errors.push(`${name}: is empty; there is nothing to check`)
    for (const file of found) {
      const label = relative(root, file) || file
      if (COMPRESSED.test(file)) {
        errors.push(`${label}: compressed archive; pass the extracted output instead`)
        continue
      }
      files++
      // Byte content read as UTF-8: bundles, archives such as app.asar and
      // Hermes bytecode keep their strings as UTF-8 bytes.
      const text = readFileSync(file).toString('utf8')
      // Only shipped files count: a source map embeds the original sources, so
      // it can contain the label even when the bundle does not.
      if (!file.endsWith('.map')) {
        if (text.includes(labels.label)) seen.label = true
        if (text.includes(labels.notice)) seen.notice = true
      }
      if (flavour === 'real') {
        const records = markers.filter((marker) => text.includes(marker))
        if (records.length)
          errors.push(
            `${label}: contains synthetic fixture records (${records
              .slice(0, 3)
              .map((marker) => `"${marker}"`)
              .join(
                ', ',
              )}${records.length > 3 ? ` and ${records.length - 3} more` : ''})`,
          )
      }
      for (const leak of leaks)
        if (text.includes(leak))
          errors.push(`${label}: contains the build machine path ${leak}`)
      if (!file.endsWith('.map')) continue
      maps++
      let map
      try {
        map = JSON.parse(text)
      } catch {
        errors.push(`${label}: source map is not valid JSON`)
        continue
      }
      if (map.sourceRoot && ABSOLUTE.test(map.sourceRoot))
        errors.push(`${label}: absolute sourceRoot ${map.sourceRoot}`)
      for (const source of map.sources ?? []) {
        if (ABSOLUTE.test(source)) errors.push(`${label}: absolute source path ${source}`)
        if (flavour === 'real' && /packages\/fixtures\/|@cindl\/fixtures/.test(source))
          errors.push(`${label}: bundles the synthetic fixtures (${source})`)
      }
    }
    if (flavour === 'demo') {
      if (!seen.notice)
        errors.push(`${name}: demo output lacks the demo notice (SYNTHETIC_DEMO_NOTICE)`)
      if (!seen.label)
        errors.push(`${name}: demo output lacks the demo label (SYNTHETIC_DEMO_LABEL)`)
    }
  }
  return { errors, files, maps }
}
