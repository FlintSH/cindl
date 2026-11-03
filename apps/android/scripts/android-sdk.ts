/**
 * Guard for the Android SDK packages CI uses (sdk/android-sdk.ts).
 *
 *   node scripts/android-sdk.ts verify-repositories <build|emulator>
 *   node scripts/android-sdk.ts verify-installed <build|emulator> <sdk-root> [report.json]
 *   node scripts/android-sdk.ts install emulator <sdk-root>
 *   node scripts/android-sdk.ts value <ndk|cmake|abis|image>
 *
 * It never runs sdkmanager or writes licence files. `install` downloads the
 * pinned archives (checking size and SHA-1) and only on a GitHub-hosted
 * runner, the one place the owner approved the Android SDK licence for.
 */
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
  APPROVED_LICENCE,
  BUILD_PACKAGES,
  CMAKE_VERSION,
  EMULATOR_PACKAGES,
  NDK_VERSION,
  REPOSITORIES,
  TEST_APK_ABIS,
  type PinnedPackage,
  type RepositoryName,
} from '../sdk/android-sdk.ts'
import {
  checkInstalled,
  checkManifests,
  errors,
  formattingDelta,
  licenceDifference,
  MARKER_FILE,
  parseManifest,
  sourceRevision,
  type Finding,
  type InstallMarker,
  type ParsedManifest,
} from '../sdk/guard.ts'

const sets: Record<string, readonly PinnedPackage[]> = {
  build: BUILD_PACKAGES,
  emulator: EMULATOR_PACKAGES,
}

function fail(message: string): never {
  console.error(`::error::${message}`)
  process.exit(1)
}

function packagesFor(name: string | undefined): readonly PinnedPackage[] {
  const packages = name ? sets[name] : undefined
  return packages ?? fail(`Unknown package set "${name ?? ''}" (build or emulator).`)
}

function print(findings: readonly Finding[]) {
  for (const finding of findings)
    console.log(
      finding.level === 'error'
        ? `::error::${finding.message}`
        : `::notice::${finding.message}`,
    )
}

async function verifyRepositories(packages: readonly PinnedPackage[]) {
  const manifests: Partial<Record<RepositoryName, ParsedManifest>> = {}
  for (const name of new Set(packages.map((pin) => pin.repository))) {
    const response = await fetch(REPOSITORIES[name])
    if (!response.ok)
      fail(`Could not read ${REPOSITORIES[name]} (HTTP ${response.status}).`)
    manifests[name] = parseManifest(await response.text())
  }
  const findings = checkManifests(manifests, packages)
  print(findings)
  if (errors(findings).length > 0) process.exit(1)
  for (const pin of packages)
    console.log(`${pin.id} ${pin.revision}: ${APPROVED_LICENCE.id} (stable channel)`)
}

async function verifyInstalled(
  packages: readonly PinnedPackage[],
  sdkRoot: string,
  reportPath?: string,
) {
  const read = (relative: string) => {
    const file = join(sdkRoot, relative)
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }
  const { findings, installed, otherTexts, matchedTexts } = checkInstalled(read, packages)
  print(findings)
  const differences: Record<string, string> = {}
  const formatting: Record<string, string> = {}
  if (Object.keys(otherTexts).length + Object.keys(matchedTexts).length > 0) {
    // Compare with the text Google publishes (a public licence text, safe to show).
    const response = await fetch(REPOSITORIES.main)
    const approved = response.ok
      ? parseManifest(await response.text()).licences.get(APPROVED_LICENCE.id)
      : undefined
    for (const [sha1, text] of Object.entries(matchedTexts)) {
      formatting[sha1] = approved
        ? formattingDelta(text, approved)
        : `could not read ${REPOSITORIES.main} to compare`
      console.log(
        `Installed licence text ${sha1} has the approved words; formatting: ${formatting[sha1]}`,
      )
    }
    for (const [sha1, text] of Object.entries(otherTexts)) {
      differences[sha1] = approved
        ? licenceDifference(text, approved)
        : `could not read ${REPOSITORIES.main} to compare`
      console.log(`::error::Installed licence text ${sha1}: ${differences[sha1]}`)
    }
  }
  if (reportPath)
    writeFileSync(
      reportPath,
      `${JSON.stringify({ licence: APPROVED_LICENCE, sdkRoot, packages: installed, problems: findings, formatting, otherTexts, differences }, null, 2)}\n`,
    )
  if (errors(findings).length > 0) {
    fail(
      `Missing or unapproved Android SDK packages in ${sdkRoot} (see above). ` +
        'Nothing was downloaded or accepted; add a reviewed pin to sdk/android-sdk.ts.',
    )
  }
  for (const entry of installed)
    console.log(
      `${entry.id} ${entry.revision}: ${entry.licence} (${entry.source}` +
        `${entry.licenceText ? `; licence text ${entry.licenceText}` : ''})`,
    )
}

function onApprovedRunner(): boolean {
  return (
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.CINDL_RUNNER_ENVIRONMENT === 'github-hosted'
  )
}

async function download(
  pin: PinnedPackage,
  into: string,
): Promise<InstallMarker['archive']> {
  const archive = pin.archive ?? fail(`${pin.id} has no pinned archive.`)
  const response = await fetch(archive.url)
  if (!response.ok || !response.body)
    fail(`Could not download ${archive.url} (HTTP ${response.status}).`)
  const sha1 = createHash('sha1')
  const sha256 = createHash('sha256')
  let size = 0
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sha1.update(chunk)
      sha256.update(chunk)
      size += chunk.length
      callback(null, chunk)
    },
  })
  // fetch's DOM stream type and Node's web stream type describe the same object.
  const body = response.body as unknown as NodeReadableStream<Uint8Array>
  await pipeline(Readable.fromWeb(body), measure, createWriteStream(into))
  const actual = sha1.digest('hex')
  if (size !== archive.size || actual !== archive.sha1)
    fail(
      `${archive.url}: got ${size} bytes, sha1 ${actual}; pinned ${archive.size} bytes, sha1 ${archive.sha1}.`,
    )
  return { url: archive.url, sha1: archive.sha1, size, sha256: sha256.digest('hex') }
}

async function install(packages: readonly PinnedPackage[], sdkRoot: string) {
  if (!onApprovedRunner())
    fail(
      'Refusing to download Android SDK packages: the owner approved the Android SDK licence ' +
        'only on GitHub-hosted runners (CINDL_RUNNER_ENVIRONMENT=github-hosted under GitHub Actions).',
    )
  mkdirSync(sdkRoot, { recursive: true })
  for (const pin of packages) {
    const target = join(sdkRoot, pin.path)
    const markerPath = join(target, MARKER_FILE)
    if (existsSync(markerPath)) {
      const marker = JSON.parse(
        readFileSync(markerPath, 'utf8'),
      ) as Partial<InstallMarker>
      if (
        marker.revision === pin.revision &&
        marker.archive?.sha1 === pin.archive?.sha1
      ) {
        console.log(`${pin.id} ${pin.revision}: already installed`)
        continue
      }
    }
    if (existsSync(target))
      fail(`${target} exists but is not the pinned ${pin.id} ${pin.revision}.`)
    const work = mkdtempSync(join(sdkRoot, '.download-'))
    try {
      const zip = join(work, 'archive.zip')
      const archive = await download(pin, zip)
      const unpacked = join(work, 'unpacked')
      execFileSync('unzip', ['-q', zip, '-d', unpacked], { stdio: 'inherit' })
      const top = readdirSync(unpacked)
      const expected = pin.path.slice(pin.path.lastIndexOf('/') + 1)
      if (top.length !== 1 || top[0] !== expected)
        fail(
          `${archive.url} does not contain a single ${expected}/ directory (found ${top.join(', ')}).`,
        )
      const properties = join(unpacked, expected, 'source.properties')
      const revision = existsSync(properties)
        ? sourceRevision(readFileSync(properties, 'utf8'))
        : undefined
      if (revision !== pin.revision)
        fail(
          `${pin.id}: the archive says revision ${revision ?? 'unknown'}, pinned ${pin.revision}.`,
        )
      mkdirSync(dirname(target), { recursive: true })
      renameSync(join(unpacked, expected), target)
      const marker: InstallMarker = {
        id: pin.id,
        revision: pin.revision,
        licence: APPROVED_LICENCE.id,
        licenceTextSha1: APPROVED_LICENCE.textSha1,
        archive,
      }
      writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
      console.log(
        `${pin.id} ${pin.revision}: installed from ${archive.url} (sha256 ${archive.sha256})`,
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

const [command, first, second, third] = process.argv.slice(2)
switch (command) {
  case 'verify-repositories':
    await verifyRepositories(packagesFor(first))
    break
  case 'verify-installed':
    await verifyInstalled(packagesFor(first), second ?? fail('Pass the SDK root.'), third)
    break
  case 'install':
    if (first !== 'emulator')
      fail(
        'Only the emulator packages are ever downloaded; build packages must be preinstalled.',
      )
    await install(EMULATOR_PACKAGES, second ?? fail('Pass the SDK root.'))
    break
  case 'value': {
    const values: Record<string, string> = {
      ndk: NDK_VERSION,
      cmake: CMAKE_VERSION,
      abis: TEST_APK_ABIS.join(','),
      image:
        EMULATOR_PACKAGES.find((pin) => pin.id.startsWith('system-images;'))?.id ?? '',
    }
    const value = first ? values[first] : undefined
    console.log(value ?? fail(`Unknown value "${first ?? ''}".`))
    break
  }
  default:
    fail('Usage: android-sdk.ts verify-repositories|verify-installed|install|value …')
}
