import type { CryptoProvider } from '@cindl/hermes-adapter'

/** The subset of expo-crypto used for PKCE (Hermes has no WebCrypto on Android). */
export interface ExpoCryptoLike {
  getRandomBytes(byteCount: number): Uint8Array
  digestSha256(data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>
}

/** CryptoProvider for @cindl/hermes-adapter's PKCE helpers, backed by expo-crypto. */
export function createCryptoProvider(native: ExpoCryptoLike): CryptoProvider {
  return {
    randomBytes: (length) => {
      const bytes = native.getRandomBytes(length)
      if (bytes.length !== length)
        throw new Error('Secure random source returned too few bytes')
      return bytes
    },
    sha256: async (data) =>
      new Uint8Array(await native.digestSha256(new Uint8Array(data))),
  }
}
