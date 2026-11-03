/**
 * The Android SDK packages Cindl's CI may use, pinned to exact revisions.
 *
 * Owner approval (2026-11-03): Google's Android Software Development Kit
 * License Agreement (sdkmanager id `android-sdk-license`) may be accepted for
 * Cindl APK builds and emulator tests on GitHub-hosted runners only. It does
 * not cover development machines, personal devices, paid or store services,
 * or production signing. `scripts/android-sdk.ts` enforces this list: it
 * refuses to install anything outside a GitHub-hosted runner, never runs
 * `sdkmanager --licenses` and fails on another licence, a changed licence
 * text or a missing package.
 *
 * Revisions, archives and SHA-1 checksums were read from Google's repository
 * manifests (`REPOSITORIES`) on 2026-11-03; runner contents from the GitHub
 * ubuntu-24.04 image 20261026.354.1.
 */

export const APPROVED_LICENCE = {
  id: 'android-sdk-license',
  name: 'Android Software Development Kit License Agreement',
  /**
   * SHA-1 of the licence's words (sdk/guard.ts normalizeLicenceText) as Google
   * publishes it in the manifests (read 2026-11-03; the text is dated
   * January 16, 2019).
   */
  textSha1: 'a90c249c9e874a0ca1854dd16aa9827dec1430da',
  approved: '2026-11-03',
  scope: 'Cindl APK builds and emulator tests on GitHub-hosted runners only',
} as const

export const REPOSITORIES = {
  main: 'https://dl.google.com/android/repository/repository2-3.xml',
  aospImages: 'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
} as const

export type RepositoryName = keyof typeof REPOSITORIES

export interface PinnedArchive {
  url: string
  sha1: string
  size: number
}

export interface PinnedPackage {
  /** sdkmanager package id. */
  id: string
  /** Directory under the SDK root. */
  path: string
  /** Exact revision (package.xml / source.properties). */
  revision: string
  repository: RepositoryName
  /** Why Cindl needs it, with the requirement's source. */
  reason: string
  /** Set for packages CI downloads; build packages must already be on the runner. */
  archive?: PinnedArchive
}

/** Used by the APK build. All are preinstalled on the runner; CI never installs them. */
export const BUILD_PACKAGES: readonly PinnedPackage[] = [
  {
    id: 'platforms;android-37.0',
    path: 'platforms/android-37.0',
    revision: '2',
    repository: 'main',
    reason: 'compileSdk 37 (react-native gradle/libs.versions.toml, Expo default)',
  },
  {
    id: 'build-tools;37.0.0',
    path: 'build-tools/37.0.0',
    revision: '37.0.0',
    repository: 'main',
    reason:
      'buildTools 37.0.0 (react-native gradle/libs.versions.toml); aapt2 and apksigner for the APK checks',
  },
  {
    id: 'ndk;27.3.13750724',
    path: 'ndk/27.3.13750724',
    revision: '27.3.13750724',
    repository: 'main',
    reason:
      'React Native 0.88 builds native code with NDK r27 (it names 27.1.12297006); the runner ships r27d, so plugins/withAndroidToolchain.ts selects it instead of downloading another',
  },
  {
    id: 'cmake;3.31.5',
    path: 'cmake/3.31.5',
    revision: '3.31.5',
    repository: 'main',
    reason:
      'CMake for the native code of React Native and Expo modules (no version pinned upstream); plugins/withAndroidToolchain.ts selects the preinstalled 3.31.5',
  },
]

const MAIN_ARCHIVES = 'https://dl.google.com/android/repository/'
const AOSP_IMAGE_ARCHIVES = 'https://dl.google.com/android/repository/sys-img/android/'

/** Used by the emulator tests, downloaded by CI into a separate SDK root. */
export const EMULATOR_PACKAGES: readonly PinnedPackage[] = [
  {
    id: 'platform-tools',
    path: 'platform-tools',
    revision: '37.0.1',
    repository: 'main',
    reason: 'adb, to install the APKs and drive the emulator',
    archive: {
      url: `${MAIN_ARCHIVES}platform-tools_r37.0.1-linux.zip`,
      sha1: '477254aa5f903c15cf51001717bdf347fb6b53e0',
      size: 9_054_187,
    },
  },
  {
    id: 'emulator',
    path: 'emulator',
    revision: '37.2.13',
    repository: 'main',
    reason: 'Android Emulator, stable channel (the dev channel uses another licence)',
    archive: {
      url: `${MAIN_ARCHIVES}emulator-linux_x64-16740729.zip`,
      sha1: 'f41f9e31eb5ca64926603c03265c50bbc0ff4172',
      size: 349_658_551,
    },
  },
  {
    id: 'system-images;android-36;default;x86_64',
    path: 'system-images/android-36/default/x86_64',
    revision: '2',
    repository: 'aospImages',
    reason:
      "Android 16 (API 36, the app's targetSdk), AOSP image without Google apps: on the Google APIs image the only browser is Chrome, whose first run asks to accept Google's Terms of Service, which the tests never accept",
    archive: {
      url: `${AOSP_IMAGE_ARCHIVES}x86_64-36_r02.zip`,
      sha1: '829c076e8ff448a336097ae25a355b495ba36e2c',
      size: 844_217_077,
    },
  },
]

export const NDK_VERSION = '27.3.13750724'
export const CMAKE_VERSION = '3.31.5'
/** ABIs in the CI test APKs: phones (arm64-v8a) and the x86_64 emulator. */
export const TEST_APK_ABIS = ['arm64-v8a', 'x86_64'] as const
