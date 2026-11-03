/**
 * Collects licence texts for third-party code the desktop artifact
 * redistributes: npm packages bundled into main/preload (from esbuild's
 * metafile), the renderer's runtime dependency closure (apps/web
 * `dependencies`), and the OFL fonts the renderer ships.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

interface PackageInfo {
  name: string
  version: string
  license: string
  dir: string
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i

function readManifest(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return undefined
  }
}

function info(dir: string): PackageInfo | undefined {
  const manifest = readManifest(dir)
  if (!manifest || typeof manifest.name !== 'string') return undefined
  return {
    name: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    license: typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN',
    dir,
  }
}

/** Node's lookup of `name` from a package directory (works with pnpm's layout). */
function resolvePackageDir(from: string, name: string): string | undefined {
  let dir = from
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name)
      if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The package directory that contains a bundled source file, if it is under node_modules. */
function packageDirOf(file: string): string | undefined {
  const index = file.lastIndexOf(`node_modules${path.sep}`)
  if (index < 0) return undefined
  const rest = file.slice(index + 'node_modules'.length + 1).split(path.sep)
  const depth = rest[0]?.startsWith('@') ? 2 : 1
  return file.slice(0, index) + ['node_modules', ...rest.slice(0, depth)].join(path.sep)
}

/** Workspace packages are Cindl's own code; `@types/*` ship no runtime code. */
const isExcluded = (pkg: PackageInfo) =>
  pkg.name.startsWith('@cindl/') || pkg.name.startsWith('@types/')

/** Packages behind esbuild metafile inputs (paths relative to `cwd`). */
export function bundledPackages(inputs: string[], cwd: string): PackageInfo[] {
  const found = new Map<string, PackageInfo>()
  for (const input of inputs) {
    const dir = packageDirOf(path.resolve(cwd, input))
    const pkg = dir && info(dir)
    if (pkg && !isExcluded(pkg)) found.set(`${pkg.name}@${pkg.version}`, pkg)
  }
  return [...found.values()]
}

/** Runtime (`dependencies`) closure of a workspace package, excluding Cindl's own packages and type-only packages. */
export function runtimeClosure(packageDir: string): PackageInfo[] {
  const found = new Map<string, PackageInfo>()
  const queue = [realpathSync(packageDir)]
  const seen = new Set<string>()
  while (queue.length) {
    const dir = queue.shift() as string
    if (seen.has(dir)) continue
    seen.add(dir)
    const manifest = readManifest(dir)
    const pkg = info(dir)
    if (pkg && !isExcluded(pkg)) found.set(`${pkg.name}@${pkg.version}`, pkg)
    const deps = {
      ...(manifest?.dependencies as Record<string, string> | undefined),
      ...(manifest?.optionalDependencies as Record<string, string> | undefined),
    }
    for (const name of Object.keys(deps)) {
      const resolved = resolvePackageDir(dir, name)
      if (resolved) queue.push(resolved)
    }
  }
  return [...found.values()]
}

function licenseText(dir: string): string | undefined {
  const files = readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
  if (!files.length) return undefined
  return files
    .map((name) => readFileSync(path.join(dir, name), 'utf8').trim())
    .join('\n\n')
}

export function renderLicenses(options: {
  header: string
  packages: PackageInfo[]
  extra: Array<{ title: string; file: string }>
}): { text: string; missing: string[] } {
  const unique = new Map(
    options.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]),
  )
  const sorted = [...unique.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  )
  const missing: string[] = []
  const sections = sorted.map((pkg) => {
    const text = licenseText(pkg.dir)
    if (!text) missing.push(`${pkg.name}@${pkg.version}`)
    return `${pkg.name}@${pkg.version} (${pkg.license})\n\n${text ?? `Licence: ${pkg.license}. No licence file was included in the published package.`}`
  })
  for (const extra of options.extra)
    sections.push(`${extra.title}\n\n${readFileSync(extra.file, 'utf8').trim()}`)
  const rule = `\n\n${'-'.repeat(78)}\n\n`
  return { text: `${options.header.trim()}${rule}${sections.join(rule)}\n`, missing }
}
