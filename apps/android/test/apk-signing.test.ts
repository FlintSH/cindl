/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  normalizeSha256,
  PUBLIC_DEBUG_CERT_SHA256,
  readSigning,
  RELEASE_CERT_SHA256,
  signingProblems,
  TEST_CERT_NAME,
} from '../scripts/apk-signing.ts'

const RELEASE_HEX = 'a4105f20f7fa5901035eb08db22e02cc8402b922f59d77d79e532a920e2bb9b6'
const OTHER_HEX = 'b'.repeat(64)

/** `apksigner verify --verbose --print-certs` output, as build-tools 36 prints it. */
const apksigner = (dn: string, sha256: string, v2 = true) =>
  [
    'Verifies',
    'Verified using v1 scheme (JAR signing): false',
    `Verified using v2 scheme (APK Signature Scheme v2): ${String(v2)}`,
    'Verified using v3 scheme (APK Signature Scheme v3): true',
    'Number of signers: 1',
    `Signer #1 certificate DN: ${dn}`,
    `Signer #1 certificate SHA-256 digest: ${sha256}`,
    'Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567',
  ].join('\n')

describe('the release certificate', () => {
  it('is the committed fingerprint, read with or without colons, in any case', () => {
    expect(normalizeSha256(RELEASE_CERT_SHA256)).toBe(RELEASE_HEX)
    expect(normalizeSha256(RELEASE_HEX.toUpperCase())).toBe(RELEASE_HEX)
    expect(normalizeSha256(` ${RELEASE_CERT_SHA256.toLowerCase()} `)).toBe(RELEASE_HEX)
    expect(normalizeSha256('A4:10')).toBeUndefined()
    expect(normalizeSha256(undefined)).toBeUndefined()
  })

  it('is the one the install guide gives to compare against', () => {
    const guide = readFileSync(
      new URL('../../../docs/handbook/clients/android.md', import.meta.url),
      'utf8',
    )
    expect(guide).toContain(RELEASE_CERT_SHA256)
  })
})

describe("check-apk's signing checks", () => {
  it('accepts a release APK signed with the release key', () => {
    const signing = readSigning(apksigner('CN=Cindl, O=Cindl', RELEASE_HEX))
    expect(signing.certSha256).toBe(RELEASE_HEX)
    expect(signingProblems(signing, 'release')).toEqual([])
  })

  it('refuses a release APK signed with another key, the test key or the public debug key', () => {
    expect(
      signingProblems(readSigning(apksigner('CN=Cindl, O=Cindl', OTHER_HEX)), 'release'),
    ).toEqual([
      `signing certificate SHA-256 is ${OTHER_HEX}, expected the release key's ${RELEASE_HEX}`,
    ])
    expect(
      signingProblems(
        readSigning(apksigner(`CN=${TEST_CERT_NAME} (not for distribution)`, OTHER_HEX)),
        'release',
      ),
    ).toContain('signed with the CI test key, not the release key')
    expect(
      signingProblems(
        readSigning(apksigner('CN=Android Debug', PUBLIC_DEBUG_CERT_SHA256)),
        'release',
      ),
    ).toContain("signed with React Native's public debug key")
    expect(
      signingProblems(readSigning(apksigner('CN=Cindl', RELEASE_HEX, false)), 'release'),
    ).toEqual(['no v2 signature'])
    expect(signingProblems(readSigning('DOES NOT VERIFY'), 'release')).toContain(
      'no signing certificate',
    )
  })

  it('keeps a test APK to the CI test key, and refuses the release key there', () => {
    const test = apksigner(
      `CN=${TEST_CERT_NAME} (not for distribution), O=Cindl`,
      OTHER_HEX,
    )
    expect(signingProblems(readSigning(test), 'test')).toEqual([])
    expect(
      signingProblems(readSigning(apksigner('CN=Cindl, O=Cindl', RELEASE_HEX)), 'test'),
    ).toEqual(['signer is "CN=Cindl, O=Cindl", expected the CI test key'])
  })
})
