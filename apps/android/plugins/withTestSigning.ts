import { withAppBuildGradle, type ConfigPlugin } from 'expo/config-plugins'

export const TEST_SIGNING_MARKER = '// Cindl: test signing'
export const TEST_KEY_ALIAS = 'cindl-test'

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
 * Release builds are signed only with a throwaway key that CI creates for each
 * run (CINDL_TEST_KEYSTORE, PKCS12, password in CINDL_TEST_KEYSTORE_PASSWORD).
 * Without it the release APK stays unsigned. The template's debug.keystore is
 * public, so an APK signed with it could be "updated" by anyone's build and
 * inherit Cindl's data, including its Keystore-protected tokens. Production
 * signing is out of scope (ADR 0008).
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
        `${indent}debug {`,
      ].join('\n'),
  )
  return replaceOnce(
    withConfig,
    RELEASE_SIGNING,
    (_match, prefix = '') =>
      `${prefix}signingConfig(System.getenv('CINDL_TEST_KEYSTORE') ? signingConfigs.cindlTest : null)`,
  )
}

export const withTestSigning: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy')
      throw new Error('withTestSigning: android/app/build.gradle must be Groovy.')
    modConfig.modResults.contents = useTestSigning(modConfig.modResults.contents)
    return modConfig
  })
