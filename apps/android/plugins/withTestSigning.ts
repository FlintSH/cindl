import { withAppBuildGradle, type ConfigPlugin } from 'expo/config-plugins'

export const TEST_SIGNING_MARKER = '// Cindl: test signing'
export const RELEASE_SIGNING_MARKER = '// Cindl: release signing'
export const TEST_KEY_ALIAS = 'cindl-test'

/** The release key's secrets, read from the environment only (never argv or -P properties). */
export const RELEASE_SECRETS = [
  'CINDL_ANDROID_KEYSTORE_PASSWORD',
  'CINDL_ANDROID_KEY_ALIAS',
  'CINDL_ANDROID_KEY_PASSWORD',
] as const

/** What the release build type signs with: the release key, else the CI test key, else nothing. */
export const RELEASE_SIGNING_CONFIG =
  "signingConfig(System.getenv('CINDL_RELEASE_KEYSTORE') ? signingConfigs.cindlRelease : System.getenv('CINDL_TEST_KEYSTORE') ? signingConfigs.cindlTest : null)"

const BOTH_KEYS =
  'Cindl signing: CINDL_RELEASE_KEYSTORE and CINDL_TEST_KEYSTORE are both set; a build takes one key.'
const DEMO_RELEASE =
  'Cindl signing: a demo build (EXPO_PUBLIC_CINDL_DEMO=1) never takes the release key.'
const missingMessage = (names: string) =>
  `Cindl signing: CINDL_RELEASE_KEYSTORE is set but not ${names}.`

const SIGNING_CONFIGS = /signingConfigs \{\n(\s*)debug \{/g
const RELEASE_SIGNING =
  /(release \{\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*)signingConfig signingConfigs\.debug/g

function replaceOnce(
  text: string,
  pattern: RegExp,
  replace: (...groups: string[]) => string,
) {
  const matches = [...text.matchAll(pattern)]
  if (matches.length !== 1)
    throw new Error(
      `withTestSigning: expected one match of ${pattern.source} in app/build.gradle.`,
    )
  return text.replace(pattern, (...args: unknown[]) => replace(...(args as string[])))
}

/**
 * Why this environment must not build at all, or undefined. The same rules as
 * the Gradle block below, checked at prebuild so a release run stops before
 * its long build, and testable without a JVM. Names variables, never values.
 */
export function signingProblem(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!env.CINDL_RELEASE_KEYSTORE) return undefined
  if (env.CINDL_TEST_KEYSTORE) return BOTH_KEYS
  if (env.EXPO_PUBLIC_CINDL_DEMO === '1') return DEMO_RELEASE
  const missing = RELEASE_SECRETS.filter((name) => !env[name])
  return missing.length ? missingMessage(missing.join(', ')) : undefined
}

/**
 * Release builds are signed with one of two keys, chosen by the environment:
 *
 * - a throwaway key that CI creates for each test run (CINDL_TEST_KEYSTORE,
 *   PKCS12, password in CINDL_TEST_KEYSTORE_PASSWORD);
 * - the owner's stable release key, only for a published release built on a
 *   `v*` tag (CINDL_RELEASE_KEYSTORE, PKCS12, with RELEASE_SECRETS).
 *
 * With neither the release APK stays unsigned. The template's debug.keystore is
 * public, so an APK signed with it could be "updated" by anyone's build and
 * inherit Cindl's data, including its Keystore-protected tokens. The release
 * config fails closed: a missing secret, both keys at once, or a demo build
 * with the release key stops the build.
 */
export function useTestSigning(buildGradle: string): string {
  if (buildGradle.includes(TEST_SIGNING_MARKER)) return buildGradle
  const withConfig = replaceOnce(
    buildGradle,
    SIGNING_CONFIGS,
    (_match, indent = '        ') =>
      [
        'signingConfigs {',
        `${indent}${TEST_SIGNING_MARKER}: a throwaway key per CI run (apps/android/plugins/withTestSigning.ts).`,
        `${indent}cindlTest {`,
        `${indent}    def keystore = System.getenv('CINDL_TEST_KEYSTORE')`,
        `${indent}    if (keystore) {`,
        `${indent}        storeFile file(keystore)`,
        `${indent}        storeType 'PKCS12'`,
        `${indent}        storePassword System.getenv('CINDL_TEST_KEYSTORE_PASSWORD')`,
        `${indent}        keyAlias '${TEST_KEY_ALIAS}'`,
        `${indent}        keyPassword System.getenv('CINDL_TEST_KEYSTORE_PASSWORD')`,
        `${indent}    }`,
        `${indent}}`,
        `${indent}${RELEASE_SIGNING_MARKER}: the owner's stable key, on a v* tag only (apps/android/plugins/withTestSigning.ts).`,
        `${indent}cindlRelease {`,
        `${indent}    def keystore = System.getenv('CINDL_RELEASE_KEYSTORE')`,
        `${indent}    if (keystore) {`,
        `${indent}        if (System.getenv('CINDL_TEST_KEYSTORE'))`,
        `${indent}            throw new GradleException('${BOTH_KEYS}')`,
        `${indent}        if (System.getenv('EXPO_PUBLIC_CINDL_DEMO') == '1')`,
        `${indent}            throw new GradleException('${DEMO_RELEASE}')`,
        `${indent}        def missing = [${RELEASE_SECRETS.map((name) => `'${name}'`).join(', ')}].findAll { !System.getenv(it) }`,
        `${indent}        if (missing)`,
        `${indent}            throw new GradleException("${missingMessage("${missing.join(', ')}")}")`,
        `${indent}        storeFile file(keystore)`,
        `${indent}        storeType 'PKCS12'`,
        `${indent}        storePassword System.getenv('CINDL_ANDROID_KEYSTORE_PASSWORD')`,
        `${indent}        keyAlias System.getenv('CINDL_ANDROID_KEY_ALIAS')`,
        `${indent}        keyPassword System.getenv('CINDL_ANDROID_KEY_PASSWORD')`,
        `${indent}    }`,
        `${indent}}`,
        `${indent}debug {`,
      ].join('\n'),
  )
  return replaceOnce(
    withConfig,
    RELEASE_SIGNING,
    (_match, prefix = '') => `${prefix}${RELEASE_SIGNING_CONFIG}`,
  )
}

export const withTestSigning: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy')
      throw new Error('withTestSigning: android/app/build.gradle must be Groovy.')
    const problem = signingProblem(process.env)
    if (problem) throw new Error(problem)
    modConfig.modResults.contents = useTestSigning(modConfig.modResults.contents)
    return modConfig
  })
