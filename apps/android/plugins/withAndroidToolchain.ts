import { withProjectBuildGradle, type ConfigPlugin } from 'expo/config-plugins'
import { CMAKE_VERSION, NDK_VERSION } from '../sdk/android-sdk.ts'

export const TOOLCHAIN_MARKER = '// Cindl: pinned Android toolchain'
const EXPO_ROOT_PLUGIN = 'apply plugin: "expo-root-project"'

/**
 * Pins the NDK and CMake that every native module builds with to the packages
 * in sdk/android-sdk.ts, which GitHub's runner image already has. React
 * Native names NDK 27.1.12297006 and nobody names a CMake version, so without
 * this the Android Gradle plugin would look for packages the runner lacks
 * (and, with android.builder.sdkDownload=false, fail rather than fetch them).
 * `ext.ndkVersion` must be set before Expo's root plugin, which copies it to
 * every library module.
 */
export function pinToolchain(buildGradle: string): string {
  if (buildGradle.includes(TOOLCHAIN_MARKER)) return buildGradle
  const at = buildGradle.indexOf(EXPO_ROOT_PLUGIN)
  if (at < 0 || buildGradle.indexOf(EXPO_ROOT_PLUGIN, at + 1) >= 0)
    throw new Error(
      `withAndroidToolchain: expected one "${EXPO_ROOT_PLUGIN}" in android/build.gradle.`,
    )
  const block = [
    `${TOOLCHAIN_MARKER} (apps/android/sdk/android-sdk.ts).`,
    `ext.ndkVersion = '${NDK_VERSION}'`,
    'subprojects { subproject ->',
    "  ['com.android.application', 'com.android.library'].each { pluginId ->",
    '    subproject.plugins.withId(pluginId) {',
    "      subproject.extensions.getByName('androidComponents').finalizeDsl { android ->",
    `        android.externalNativeBuild.cmake.version = '${CMAKE_VERSION}'`,
    '      }',
    '    }',
    '  }',
    '}',
    '',
    '',
  ].join('\n')
  return buildGradle.slice(0, at) + block + buildGradle.slice(at)
}

export const withAndroidToolchain: ConfigPlugin = (config) =>
  withProjectBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy')
      throw new Error('withAndroidToolchain: android/build.gradle must be Groovy.')
    modConfig.modResults.contents = pinToolchain(modConfig.modResults.contents)
    return modConfig
  })
