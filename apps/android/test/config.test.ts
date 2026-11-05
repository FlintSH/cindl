/// <reference types="node" />
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_PRODUCT_NAME } from '@cindl/contracts'
import type { ExpoConfig } from 'expo/config'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import appConfig, { versionCodeOf } from '../app.config.ts'
import {
  DEBUG_NETWORK_SECURITY_CONFIG,
  RELEASE_NETWORK_SECURITY_CONFIG,
} from '../plugins/withNetworkSecurity.ts'
import {
  disableSdkDownloads,
  SDK_DOWNLOAD_PROPERTY,
} from '../plugins/withNoSdkDownloads.ts'
import { pinToolchain, TOOLCHAIN_MARKER } from '../plugins/withAndroidToolchain.ts'
import {
  RELEASE_SECRETS,
  RELEASE_SIGNING_CONFIG,
  RELEASE_SIGNING_MARKER,
  signingProblem,
  TEST_KEY_ALIAS,
  useTestSigning,
} from '../plugins/withTestSigning.ts'
import { CMAKE_VERSION, NDK_VERSION } from '../sdk/android-sdk.ts'

const build = (demo: boolean): ExpoConfig => {
  process.env.EXPO_PUBLIC_CINDL_DEMO = demo ? '1' : ''
  return appConfig({
    config: {},
    projectRoot: '.',
    staticConfigPath: null,
    packageJsonPath: null,
  })
}

describe('Android app config', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_CINDL_DEMO
  })

  it('names the demo flavour Cindl Demo and the real one Cindl, with one application id', () => {
    expect(build(true).name).toBe(DEMO_PRODUCT_NAME)
    expect(build(false).name).toBe('Cindl')
    expect(build(true).android?.package).toBe('dev.fl1nt.cindl')
  })

  it('requests INTERNET only and keeps data out of backups', () => {
    const android = build(false).android
    expect(android?.permissions).toEqual(['android.permission.INTERNET'])
    expect(android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ]),
    )
    expect(android?.allowBackup).toBe(false)
  })

  it('allows cleartext only to loopback IP literals in release builds', () => {
    const hosts = (xml: string) =>
      [...xml.matchAll(/<domain includeSubdomains="false">([^<]+)<\/domain>/g)].map(
        (m) => m[1],
      )
    expect(hosts(RELEASE_NETWORK_SECURITY_CONFIG)).toEqual(['127.0.0.1', '::1'])
    expect(RELEASE_NETWORK_SECURITY_CONFIG).toContain(
      '<base-config cleartextTrafficPermitted="false">',
    )
    expect(RELEASE_NETWORK_SECURITY_CONFIG).toContain('<certificates src="system" />')
    expect(RELEASE_NETWORK_SECURITY_CONFIG).not.toContain('src="user"')
    expect(hosts(DEBUG_NETWORK_SECURITY_CONFIG)).toEqual([
      '127.0.0.1',
      '::1',
      'localhost',
      '10.0.2.2',
    ])
  })

  it('never lets Gradle download Android SDK packages', () => {
    const properties = disableSdkDownloads([
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2048m' },
      { type: 'property', key: SDK_DOWNLOAD_PROPERTY, value: 'true' },
    ])
    const values = properties.flatMap((item) =>
      item.type === 'property' && item.key === SDK_DOWNLOAD_PROPERTY ? [item.value] : [],
    )
    expect(values).toEqual(['false'])
    expect(properties[0]).toEqual({
      type: 'property',
      key: 'org.gradle.jvmargs',
      value: '-Xmx2048m',
    })
    expect(SDK_DOWNLOAD_PROPERTY).toBe('android.builder.sdkDownload')
    // The app config registers the gradle.properties change for every flavour.
    for (const demo of [true, false]) {
      const config = build(demo) as ExpoConfig & {
        mods?: { android?: { gradleProperties?: unknown } }
      }
      expect(typeof config.mods?.android?.gradleProperties).toBe('function')
    }
  })
})

// The parts of Expo SDK 58's bare template these plugins rewrite (android/build.gradle, app/build.gradle).
const ROOT_BUILD_GRADLE = `allprojects {
  repositories {
    google()
  }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
`
const APP_BUILD_GRADLE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`

describe('Android toolchain pins', () => {
  it('sets the NDK before Expo copies it to every module and pins CMake everywhere', () => {
    const pinned = pinToolchain(ROOT_BUILD_GRADLE)
    const block = pinned.slice(
      pinned.indexOf(TOOLCHAIN_MARKER),
      pinned.indexOf('apply plugin: "expo-root-project"'),
    )
    expect(block).toContain(`ext.ndkVersion = '${NDK_VERSION}'`)
    expect(block).toContain(
      `android.externalNativeBuild.cmake.version = '${CMAKE_VERSION}'`,
    )
    expect(block).toContain("['com.android.application', 'com.android.library']")
    expect(pinToolchain(pinned)).toBe(pinned)
    expect(() => pinToolchain('apply plugin: "com.facebook.react.rootproject"')).toThrow(
      /expected one/,
    )
  })
})

describe('test signing', () => {
  it('signs release builds only with the per-run CI key, never the public debug key', () => {
    const signed = useTestSigning(APP_BUILD_GRADLE)
    const release = signed.slice(signed.indexOf('release {'))
    expect(release).toContain(RELEASE_SIGNING_CONFIG)
    expect(release).not.toContain('signingConfig signingConfigs.debug')
    expect(signed).toContain(`keyAlias '${TEST_KEY_ALIAS}'`)
    expect(signed).toContain("storeType 'PKCS12'")
    // Local debug builds (Metro) keep the template's debug key.
    expect(
      signed.slice(signed.indexOf('buildTypes'), signed.indexOf('release {')),
    ).toContain('signingConfig signingConfigs.debug')
    expect(useTestSigning(signed)).toBe(signed)
    expect(() =>
      useTestSigning(APP_BUILD_GRADLE.replace('release {', 'staging {')),
    ).toThrow(/expected one/)
  })
})

describe('the release version', () => {
  it('is 1.1.0, with a versionCode that grows with every release (major, minor, patch)', () => {
    expect(build(false).version).toBe('1.1.0')
    expect(build(false).android?.versionCode).toBe(10_100)
    expect(build(true).android?.versionCode).toBe(10_100)
    expect(versionCodeOf('1.0.1')).toBe(10_001)
    expect(versionCodeOf('1.1.0')).toBe(10_100)
    expect(versionCodeOf('2.0.0')).toBe(20_000)
    expect(() => versionCodeOf('1.0')).toThrow(/major\.minor\.patch/)
    expect(() => versionCodeOf('1.100.0')).toThrow(/over 99/)
  })
})

describe('release signing', () => {
  it('signs a release with the release key from the environment only, PKCS12, and fails closed in Gradle', () => {
    const signed = useTestSigning(APP_BUILD_GRADLE)
    const start = signed.indexOf('cindlRelease {')
    const block = signed.slice(start, signed.indexOf('debug {', start))
    expect(signed).toContain(RELEASE_SIGNING_MARKER)
    expect(block).toContain("def keystore = System.getenv('CINDL_RELEASE_KEYSTORE')")
    expect(block).toContain("storeType 'PKCS12'")
    expect(block).toContain(
      "storePassword System.getenv('CINDL_ANDROID_KEYSTORE_PASSWORD')",
    )
    expect(block).toContain("keyAlias System.getenv('CINDL_ANDROID_KEY_ALIAS')")
    expect(block).toContain("keyPassword System.getenv('CINDL_ANDROID_KEY_PASSWORD')")
    for (const name of RELEASE_SECRETS) expect(block).toContain(`'${name}'`)
    // Never a Gradle property (-P on a command line) for a signing value.
    expect(block).not.toMatch(/findProperty|hasProperty|gradleProperty|project\./)
    // The same three refusals as at prebuild, naming variables only.
    expect(block).toContain("if (System.getenv('CINDL_TEST_KEYSTORE'))")
    expect(block).toContain("if (System.getenv('EXPO_PUBLIC_CINDL_DEMO') == '1')")
    expect(block).toContain(
      'throw new GradleException("Cindl signing: CINDL_RELEASE_KEYSTORE is set but not ${missing.join(\', \')}.")',
    )
    expect(block.match(/throw new GradleException/g)).toHaveLength(3)
    // The release key first, else the test key, else unsigned.
    expect(signed.slice(signed.indexOf('release {'))).toContain(RELEASE_SIGNING_CONFIG)
  })

  describe('the environment a build may sign with, checked at prebuild', () => {
    // A throwaway keystore file made here, as CI makes one for each run (CI
    // with keytool; nothing reads this one before Gradle signs with it).
    const dir = mkdtempSync(join(tmpdir(), 'cindl-signing-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const keystore = join(dir, 'cindl-release.p12')
    writeFileSync(keystore, randomBytes(256), { mode: 0o600 })
    const secrets = {
      CINDL_ANDROID_KEYSTORE_PASSWORD: 'store-password-fixture',
      CINDL_ANDROID_KEY_ALIAS: 'alias-fixture',
      CINDL_ANDROID_KEY_PASSWORD: 'key-password-fixture',
    }
    const release = { CINDL_RELEASE_KEYSTORE: keystore, ...secrets }

    it('lets through a release, a test build and an unsigned one', () => {
      expect(signingProblem({})).toBeUndefined()
      expect(
        signingProblem({
          CINDL_TEST_KEYSTORE: keystore,
          CINDL_TEST_KEYSTORE_PASSWORD: 'x',
        }),
      ).toBeUndefined()
      expect(signingProblem(release)).toBeUndefined()
      expect(signingProblem({ ...release, EXPO_PUBLIC_CINDL_DEMO: '' })).toBeUndefined()
    })

    it('refuses the release key without any of its secrets, naming it and no value', () => {
      for (const name of RELEASE_SECRETS)
        for (const gone of [undefined, '']) {
          const problem = signingProblem({ ...release, [name]: gone })
          expect(problem).toBe(
            `Cindl signing: CINDL_RELEASE_KEYSTORE is set but not ${name}.`,
          )
          for (const value of Object.values(secrets)) expect(problem).not.toContain(value)
        }
      expect(signingProblem({ CINDL_RELEASE_KEYSTORE: keystore })).toBe(
        `Cindl signing: CINDL_RELEASE_KEYSTORE is set but not ${RELEASE_SECRETS.join(', ')}.`,
      )
    })

    it('refuses both keys at once, and a demo build with the release key', () => {
      expect(signingProblem({ ...release, CINDL_TEST_KEYSTORE: keystore })).toMatch(
        /both set; a build takes one key/,
      )
      expect(signingProblem({ ...release, EXPO_PUBLIC_CINDL_DEMO: '1' })).toMatch(
        /demo build .* never takes the release key/,
      )
    })
  })
})
