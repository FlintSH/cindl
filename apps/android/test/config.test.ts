/// <reference types="node" />
import { DEMO_PRODUCT_NAME } from '@cindl/contracts'
import type { ExpoConfig } from 'expo/config'
import { afterEach, describe, expect, it } from 'vitest'
import appConfig from '../app.config.ts'
import {
  DEBUG_NETWORK_SECURITY_CONFIG,
  RELEASE_NETWORK_SECURITY_CONFIG,
} from '../plugins/withNetworkSecurity.ts'
import {
  disableSdkDownloads,
  SDK_DOWNLOAD_PROPERTY,
} from '../plugins/withNoSdkDownloads.ts'
import { pinToolchain, TOOLCHAIN_MARKER } from '../plugins/withAndroidToolchain.ts'
import { TEST_KEY_ALIAS, useTestSigning } from '../plugins/withTestSigning.ts'
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
    expect(release).toContain(
      "signingConfig(System.getenv('CINDL_TEST_KEYSTORE') ? signingConfigs.cindlTest : null)",
    )
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
