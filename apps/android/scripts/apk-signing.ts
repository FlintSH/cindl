/**
 * What check-apk.ts asks of an APK's signature, kept apart from the script so
 * it can be tested on apksigner's output without the SDK.
 */

/** Certificate of the debug.keystore that React Native's template ships to everyone. */
export const PUBLIC_DEBUG_CERT_SHA256 =
  'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'
export const TEST_CERT_NAME = 'Cindl CI test build'
/**
 * The owner's release key (PKCS12, alias `cindl`): its certificate's SHA-256,
 * public, valid until 2056-10-27. A release APK must be signed by it; the
 * install guide (docs/handbook/clients/android.md) gives the same value.
 */
export const RELEASE_CERT_SHA256 =
  'A4:10:5F:20:F7:FA:59:01:03:5E:B0:8D:B2:2E:02:CC:84:02:B9:22:F5:9D:77:D7:9E:53:2A:92:0E:2B:B9:B6'

/** A test APK carries the CI's throwaway key; a release APK the owner's stable key. */
export type SigningMode = 'test' | 'release'

/**
 * A SHA-256 certificate fingerprint as 64 lowercase hex digits, from keytool's
 * `AA:BB:…` or plain hex; undefined when the value is not one.
 */
export function normalizeSha256(value: string | undefined): string | undefined {
  const hex = value?.trim().toLowerCase().replace(/[:\s]/g, '')
  return hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? hex : undefined
}

export interface Signing {
  /** The first signer's certificate DN. */
  signer: string | undefined
  /** The first signer's certificate SHA-256, as apksigner prints it. */
  certSha256: string | undefined
  /** apksigner's verdict lines, for the report. */
  lines: string[]
  v2: boolean
}

/**
 * Reads `apksigner verify --verbose --print-certs` (stdout and stderr together:
 * its wording varies by version, "Signer #1 …" or "Signer (minSdkVersion=…) …",
 * and some lines go to stderr).
 */
export function readSigning(output: string): Signing {
  return {
    signer: /Signer\b[^\n]*?certificate DN: (.+)/.exec(output)?.[1]?.trim(),
    certSha256: /Signer\b[^\n]*?certificate SHA-256 digest: ([0-9a-f]+)/.exec(
      output,
    )?.[1],
    lines: output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) =>
        /^(Verifies|Verified|Number of signers|Signer|DOES NOT VERIFY|ERROR)/.test(line),
      ),
    v2: /Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(output),
  }
}

/**
 * What is wrong with an APK's signature for its mode. Every APK needs a v2
 * signature and never the public debug key. A test APK is signed by the CI's
 * throwaway key (its DN names TEST_CERT_NAME); a release APK by the release
 * key, RELEASE_CERT_SHA256, with no way to expect another.
 */
export function signingProblems(signing: Signing, mode: SigningMode): string[] {
  const problems: string[] = []
  if (!signing.v2) problems.push('no v2 signature')
  if (signing.certSha256 === undefined) problems.push('no signing certificate')
  if (signing.certSha256 === PUBLIC_DEBUG_CERT_SHA256)
    problems.push("signed with React Native's public debug key")
  if (mode === 'test') {
    if (signing.signer?.includes(TEST_CERT_NAME) !== true)
      problems.push(`signer is "${signing.signer ?? ''}", expected the CI test key`)
    return problems
  }
  const expected = normalizeSha256(RELEASE_CERT_SHA256)
  if (expected === undefined) problems.push('RELEASE_CERT_SHA256 is not a SHA-256')
  else if (
    signing.certSha256 !== undefined &&
    normalizeSha256(signing.certSha256) !== expected
  )
    problems.push(
      `signing certificate SHA-256 is ${signing.certSha256}, expected the release key's ${expected}`,
    )
  if (signing.signer?.includes(TEST_CERT_NAME) === true)
    problems.push('signed with the CI test key, not the release key')
  return problems
}
