/**
 * Writes the licence notices for the native libraries in the APK, which the
 * npm notices (scripts/third-party-notices.ts) do not cover:
 *
 *   node scripts/native-notices.ts <dependency-report> <gradle-cache> <out-file>
 *
 * <dependency-report> is the output of `gradle :app:dependencies
 * --configuration releaseRuntimeClasspath`; <gradle-cache> is Gradle's
 * modules-2/files-2.1 directory after a build downloaded the artifacts (Expo's
 * local Maven repositories in node_modules are searched too). Every library
 * is listed with the licence its POM declares (parent POMs followed), and the
 * licence and notice files in its JAR or AAR, which the Android Gradle plugin
 * leaves out of the APK, are reproduced. CI runs this between two Gradle
 * builds so the file is packaged in the APK (assets/licenses).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { licenceFiles } from '../notices/archives.ts'
import {
  coordinateId,
  formatNativeNotices,
  parseDependencyReport,
  parsePom,
  type Coordinate,
  type NativeLibrary,
  type Pom,
} from '../notices/native.ts'

const [reportArg, cacheArg, outArg] = process.argv.slice(2)
if (!reportArg || !cacheArg || !outArg) {
  console.error('Usage: native-notices.ts <dependency-report> <gradle-cache> <out-file>')
  process.exit(2)
}
const reportPath = reportArg
const cacheDir = cacheArg
const outFile = outArg
const repoRoot = join(import.meta.dirname, '..', '..', '..')

/** Expo modules ship prebuilt AARs in local Maven repositories inside their npm packages. */
function localMavenRepos(): string[] {
  const store = join(repoRoot, 'node_modules', '.pnpm')
  if (!existsSync(store)) return []
  const repos: string[] = []
  for (const entry of readdirSync(store)) {
    const modules = join(store, entry, 'node_modules')
    if (!existsSync(modules)) continue
    for (const name of readdirSync(modules)) {
      const packages = name.startsWith('@')
        ? readdirSync(join(modules, name)).map((scoped) => join(modules, name, scoped))
        : [join(modules, name)]
      for (const pkg of packages)
        if (existsSync(join(pkg, 'local-maven-repo')))
          repos.push(join(pkg, 'local-maven-repo'))
    }
  }
  return repos
}
const localRepos = localMavenRepos()

/** The files Gradle resolved for a library: cache layout <group>/<module>/<version>/<hash>/<file>. */
function artifactFiles(c: Coordinate): { dir: string; files: string[] } | undefined {
  const cached = join(cacheDir, c.group, c.module, c.version)
  if (existsSync(cached))
    return {
      dir: cached,
      files: readdirSync(cached).flatMap((hash) =>
        statSync(join(cached, hash)).isDirectory()
          ? readdirSync(join(cached, hash)).map((file) => join(cached, hash, file))
          : [],
      ),
    }
  for (const repo of localRepos) {
    const dir = join(repo, ...c.group.split('.'), c.module, c.version)
    if (existsSync(dir))
      return { dir, files: readdirSync(dir).map((file) => join(dir, file)) }
  }
  return undefined
}

function licencesOf(c: Coordinate, depth = 0): Pom['licences'] {
  const pomFile = artifactFiles(c)?.files.find((file) => file.endsWith('.pom'))
  if (!pomFile) return []
  const pom = parsePom(readFileSync(pomFile, 'utf8'))
  if (pom.licences.length > 0 || !pom.parent || depth >= 5) return pom.licences
  return licencesOf(pom.parent, depth + 1)
}

const coordinates = parseDependencyReport(readFileSync(reportPath, 'utf8'))
if (coordinates.length === 0) {
  console.error(
    `::error::No libraries in ${reportPath}; expected the releaseRuntimeClasspath report.`,
  )
  process.exit(1)
}
const libraries: NativeLibrary[] = coordinates.map((coordinate) => {
  const found = artifactFiles(coordinate)
  const archives = (found?.files ?? []).filter(
    (file) => /\.(aar|jar)$/.test(file) && !/-(sources|javadoc)\.jar$/.test(file),
  )
  return {
    coordinate,
    licences: licencesOf(coordinate),
    files: archives.flatMap(licenceFiles),
    ...(found ? { source: found.dir } : {}),
  }
})
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${formatNativeNotices(libraries)}\n`)
const files = libraries.reduce((sum, library) => sum + library.files.length, 0)
console.log(
  `Native notices: ${libraries.length} libraries, ${files} licence/notice files, written to ${outFile}`,
)
for (const library of libraries.filter(
  (l) => l.licences.length === 0 && l.files.length === 0,
))
  console.log(
    `::warning::${coordinateId(library.coordinate)} declares no licence and ships no licence file${library.source ? '' : ' (artifact not found)'}; review it.`,
  )
