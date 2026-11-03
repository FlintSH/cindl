/**
 * Writes the licence notices an APK must carry, because unlike the
 * repository it redistributes its npm dependencies:
 *
 *   node scripts/third-party-notices.ts <out-dir>
 *
 * <out-dir>/LICENSE.txt is Cindl's MIT licence. <out-dir>/THIRD-PARTY-NOTICES.txt
 * starts with THIRD_PARTY_NOTICES.md and the font licences, then lists every
 * runtime npm package reachable from apps/android/package.json (workspace
 * packages are Cindl's own) with the licence files it ships, grouped by
 * identical text. Build-only tooling reachable from `expo` is included too;
 * listing more than the bundle uses is harmless. Native libraries from Maven
 * are not covered yet (see docs/handbook/clients/android.md).
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

const appDir = join(import.meta.dirname, '..')
const repoRoot = join(appDir, '..', '..')
const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: third-party-notices.ts <out-dir>')
  process.exit(2)
}

interface Manifest {
  name?: string
  version?: string
  license?: string | { type?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const readManifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest

/** Node's lookup: <ancestor>/node_modules/<name>, nearest first. */
function resolvePackage(fromDir: string, name: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) return undefined
  }
}

interface Entry {
  name: string
  version: string
  licence: string
  texts: string[]
}

const seen = new Set<string>()
const entries: Entry[] = []
const queue: string[] = [realpathSync(appDir)]
while (queue.length > 0) {
  const dir = queue.shift() as string
  if (seen.has(dir)) continue
  seen.add(dir)
  const manifest = readManifest(dir)
  const own =
    dir === realpathSync(appDir) || !relative(repoRoot, dir).includes('node_modules')
  if (!own) {
    const licence =
      typeof manifest.license === 'string'
        ? manifest.license
        : (manifest.license?.type ?? 'UNKNOWN')
    const texts = readdirSync(dir)
      .filter((file) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(file))
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8').trim())
    entries.push({
      name: manifest.name ?? relative(repoRoot, dir),
      version: manifest.version ?? '',
      licence,
      texts,
    })
  }
  for (const name of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    const resolved = resolvePackage(dir, name)
    if (resolved) queue.push(resolved)
  }
}

entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const groups = new Map<string, { text: string; packages: string[] }>()
const withoutText: string[] = []
for (const entry of entries) {
  const id = `${entry.name}@${entry.version} (${entry.licence})`
  if (entry.texts.length === 0) {
    withoutText.push(id)
    continue
  }
  const text = entry.texts.join('\n\n')
  const key = createHash('sha256').update(text).digest('hex')
  const group = groups.get(key) ?? { text, packages: [] }
  group.packages.push(id)
  groups.set(key, group)
}

const fontLicences = ['instrument-sans', 'jetbrains-mono'].map((font) =>
  [
    `Font: ${font} (packages/tokens/fonts/${font}/OFL.txt)`,
    readFileSync(join(repoRoot, 'packages/tokens/fonts', font, 'OFL.txt'), 'utf8').trim(),
  ].join('\n\n'),
)
const rule = '='.repeat(78)
const sections = [
  'Cindl for Android: third-party notices',
  'Cindl is MIT licensed (LICENSE.txt). This build also contains the third-party material below, each under its own licence.',
  readFileSync(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8').trim(),
  ...fontLicences,
  `npm packages (${entries.length}), grouped by identical licence text:`,
  ...[...groups.values()].map((group) =>
    [group.packages.join('\n'), '', group.text].join('\n'),
  ),
  withoutText.length > 0
    ? `Packages that ship no licence file (licence as declared in package.json):\n${withoutText.join('\n')}`
    : '',
].filter(Boolean)

mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'THIRD-PARTY-NOTICES.txt'),
  `${sections.join(`\n\n${rule}\n\n`)}\n`,
)
writeFileSync(
  join(outDir, 'LICENSE.txt'),
  readFileSync(join(repoRoot, 'LICENSE'), 'utf8'),
)
console.log(
  `Wrote notices for ${entries.length} npm packages (${groups.size} licence texts) to ${outDir}`,
)
