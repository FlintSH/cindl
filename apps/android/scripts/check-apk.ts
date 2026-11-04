/**
 * Gate and report for a CI test APK or the release APK, run on the
 * GitHub-hosted runner with the pinned build-tools (aapt2, apksigner):
 *
 *   node scripts/check-apk.ts <demo|production|release> <apk> <out-dir>
 *
 * `release` checks a production APK signed with the owner's release key: its
 * certificate SHA-256 must be the committed RELEASE_CERT_SHA256 (apk-signing.ts),
 * never a value from the environment. Fails unless the APK is Cindl's (right label
 * per flavour, not debuggable, both test ABIs), asks for INTERNET only, keeps
 * backups off, allows cleartext only to the device itself, carries the
 * licence notices, is signed with the throwaway CI key or, in release mode,
 * the release key (never the public React Native debug key), its
 * JavaScript bundle passes the fixture gate for its flavour (ADR 0011) and
 * both local Kotlin modules are compiled into it.
 * Writes apk-report.json and the extracted bundle to <out-dir>.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DEMO_PRODUCT_NAME } from '@cindl/contracts'
import { BUILD_PACKAGES, TEST_APK_ABIS } from '../sdk/android-sdk.ts'
import { readSigning, signingProblems } from './apk-signing.ts'
import { KOTLIN_MODULES } from './kotlin-modules.ts'

const PACKAGE = 'dev.fl1nt.cindl'
const ALLOWED_PERMISSIONS = [
  'android.permission.INTERNET',
  // AndroidX core declares this app-private, signature-level permission for its own receivers.
  `${PACKAGE}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
]
/**
 * The local Kotlin modules (apps/android/modules), by the module names they
 * register: R8 may rename their classes, but these names are what JavaScript
 * asks for, so they stay in the dex.
 */
const NOTICES = [
  'assets/licenses/LICENSE.txt',
  'assets/licenses/THIRD-PARTY-NOTICES.txt',
  'assets/licenses/NATIVE-NOTICES.txt',
]

const [mode, apk, outDir] = process.argv.slice(2)
if ((mode !== 'demo' && mode !== 'production' && mode !== 'release') || !apk || !outDir) {
  console.error('Usage: check-apk.ts <demo|production|release> <apk> <out-dir>')
  process.exit(2)
}
// A release is the production flavour, never the demo (ADR 0011).
const flavour = mode === 'release' ? 'production' : mode

const problems: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) problems.push(message)
}

const buildTools = BUILD_PACKAGES.find((pin) => pin.id.startsWith('build-tools;'))
const androidHome: unknown = process.env.ANDROID_HOME
const toolsDir = join(
  typeof androidHome === 'string' ? androidHome : '',
  buildTools?.path ?? 'build-tools',
)
const run = (tool: string, args: string[]) =>
  execFileSync(join(toolsDir, tool), args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })

mkdirSync(outDir, { recursive: true })
const bytes = readFileSync(apk)
const sha256 = createHash('sha256').update(bytes).digest('hex')

const badging = run('aapt2', ['dump', 'badging', apk])
const field = (pattern: RegExp) => pattern.exec(badging)?.[1]
const packageName = field(/^package: name='([^']+)'/m)
const label = field(/^application-label:'([^']*)'/m)
const abis = [...(field(/^native-code: (.+)$/m) ?? '').matchAll(/'([^']+)'/g)].map(
  (m) => m[1],
)
const expectedLabel = flavour === 'demo' ? DEMO_PRODUCT_NAME : 'Cindl'
check(
  packageName === PACKAGE,
  `package is ${packageName ?? 'unknown'}, expected ${PACKAGE}`,
)
check(
  label === expectedLabel,
  `launcher label is "${label ?? ''}", expected "${expectedLabel}"`,
)
check(!/^application-debuggable/m.test(badging), 'the APK is debuggable')
for (const abi of TEST_APK_ABIS) check(abis.includes(abi), `no native code for ${abi}`)

const permissions = [
  ...run('aapt2', ['dump', 'permissions', apk]).matchAll(
    /^uses-permission: name='([^']+)'/gm,
  ),
].map((m) => m[1] ?? '')
check(permissions.includes('android.permission.INTERNET'), 'INTERNET is not requested')
for (const permission of permissions)
  check(ALLOWED_PERMISSIONS.includes(permission), `unexpected permission ${permission}`)

const manifest = run('aapt2', ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk])
const attr = (name: string, value: string) =>
  new RegExp(`:${name}\\(0x[0-9a-f]+\\)=${value}`).test(manifest)
check(attr('allowBackup', 'false'), 'allowBackup is not false')
check(attr('fullBackupContent', 'false'), 'fullBackupContent is not false')
check(attr('dataExtractionRules', '@0x[0-9a-f]+'), 'no dataExtractionRules')
check(attr('usesCleartextTraffic', 'false'), 'usesCleartextTraffic is not false')
check(attr('networkSecurityConfig', '@0x[0-9a-f]+'), 'no networkSecurityConfig')

const resources = run('aapt2', ['dump', 'resources', apk]).split('\n')
const configAt = resources.findIndex((line) =>
  / xml\/network_security_config$/.test(line),
)
const configFile =
  configAt < 0 ? undefined : /\(file\) (\S+)/.exec(resources[configAt + 1] ?? '')?.[1]
const networkConfig = configFile
  ? run('aapt2', ['dump', 'xmltree', '--file', configFile, apk])
  : ''
check(
  networkConfig.includes("'127.0.0.1'"),
  'the network security config does not name 127.0.0.1',
)
check(
  !/localhost|10\.0\.2\.2/.test(networkConfig),
  'cleartext to a development host is allowed',
)

// Both of apksigner's streams: its wording varies by version, and some lines go to stderr.
const verify = spawnSync(
  join(toolsDir, 'apksigner'),
  ['verify', '--verbose', '--print-certs', apk],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
const signing = readSigning(`${verify.stdout}\n${verify.stderr}`)
check(verify.status === 0, `apksigner verify failed (exit ${verify.status ?? 'none'})`)
problems.push(...signingProblems(signing, mode === 'release' ? 'release' : 'test'))

const entries = execFileSync('unzip', ['-Z1', apk], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean)
for (const notice of NOTICES) check(entries.includes(notice), `missing ${notice}`)

const dex = Buffer.concat(
  entries
    .filter((entry) => /^classes\d*\.dex$/.test(entry))
    .map((entry) =>
      execFileSync('unzip', ['-p', apk, entry], { maxBuffer: 512 * 1024 * 1024 }),
    ),
)
const kotlinModules = KOTLIN_MODULES.filter((name) => dex.includes(Buffer.from(name)))
for (const name of KOTLIN_MODULES)
  check(kotlinModules.includes(name), `the ${name} Kotlin module is not in the APK's dex`)
// Reported, not a gate (android.md, "No WebView"): whether any dex refers to WebView.
const refersToWebView = dex.includes(Buffer.from('Landroid/webkit/WebView;'))

const bundlePath = join(outDir, 'index.android.bundle')
check(entries.includes('assets/index.android.bundle'), 'no embedded JavaScript bundle')
let bundleGate = 'not run'
try {
  writeFileSync(
    bundlePath,
    execFileSync('unzip', ['-p', apk, 'assets/index.android.bundle'], {
      maxBuffer: 256 * 1024 * 1024,
    }),
  )
  bundleGate = execFileSync(
    process.execPath,
    [join(import.meta.dirname, 'check-bundle.ts'), flavour, bundlePath],
    { encoding: 'utf8' },
  ).trim()
} catch (error) {
  problems.push(
    `bundle gate failed: ${(error as { stdout?: string }).stdout ?? String(error)}`,
  )
}

const report = {
  mode,
  flavour,
  file: basename(apk),
  bytes: statSync(apk).size,
  sha256,
  package: packageName,
  label,
  versionName: field(/versionName='([^']*)'/),
  versionCode: field(/versionCode='([^']*)'/),
  minSdk: field(/^(?:min)?[sS]dkVersion:'([^']*)'/m),
  targetSdk: field(/^targetSdkVersion:'([^']*)'/m),
  abis,
  permissions,
  networkSecurityConfig: configFile,
  signer: signing.signer,
  signerSha256: signing.certSha256,
  signing: signing.lines,
  bundleGate,
  kotlinModules,
  refersToWebView,
  notices: NOTICES.filter((notice) => entries.includes(notice)),
  problems,
}
writeFileSync(join(outDir, 'apk-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${basename(apk)}: ${problem}`)
  process.exit(1)
}
