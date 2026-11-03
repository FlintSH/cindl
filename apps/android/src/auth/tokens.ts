import type { SecretStore } from '@cindl/client-core'
import { CindlError } from '@cindl/contracts'
import { isNativeTokenSet, type NativeTokenSet } from '@cindl/hermes-adapter'

/**
 * Hermes native tokens for one origin, kept only in the SecretStore
 * (Android Keystore-backed). Nothing here is ever logged.
 */
export interface TokenVault {
  read: (origin: string) => Promise<NativeTokenSet | undefined>
  write: (origin: string, tokens: NativeTokenSet) => Promise<void>
  clear: (origin: string) => Promise<void>
}

export const tokenKey = (origin: string) => `tokens:${origin}`

export function createTokenVault(secrets: SecretStore): TokenVault {
  return {
    async read(origin) {
      const raw = await secrets.get(tokenKey(origin))
      if (raw === undefined) return undefined
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isNativeTokenSet(parsed)) return parsed
      } catch {
        // Unreadable entries are dropped below.
      }
      await secrets.delete(tokenKey(origin))
      return undefined
    },
    async write(origin, tokens) {
      if (!secrets.available)
        throw new CindlError(
          'unavailable',
          'This device cannot encrypt secrets, so Cindl cannot keep a sign-in.',
        )
      await secrets.set(tokenKey(origin), JSON.stringify(tokens))
    },
    clear: (origin) => secrets.delete(tokenKey(origin)),
  }
}

/**
 * `expires_at` in milliseconds. Hermes sends a Unix timestamp; values below
 * 1e11 can only be seconds (1e11 ms is 1973), so both encodings are accepted.
 */
export function expiresAtMs(tokens: Pick<NativeTokenSet, 'expires_at'>): number {
  return tokens.expires_at < 1e11 ? tokens.expires_at * 1000 : tokens.expires_at
}

/** Refresh a minute early so a request never races the expiry. */
export function needsRefresh(
  tokens: Pick<NativeTokenSet, 'expires_at'>,
  nowMs: number,
  skewMs = 60_000,
): boolean {
  return expiresAtMs(tokens) - skewMs <= nowMs
}
