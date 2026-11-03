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
