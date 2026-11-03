import type { KeyValueStore, SecretStore } from '@cindl/client-core'
import { HermesOrigin } from '@cindl/contracts'
import { nativeTokensKey, wire } from '@cindl/hermes-adapter'

/**
 * The Hermes origin this device last signed in to. Not a secret; kept after a
 * sign-out so the sign-in screen can offer it again. The same key the device
 * sign-in of earlier builds used, so it carries over as it is.
 */
export const ORIGIN_KEY = 'signin.origin'

/** Where the adapter's NativeAuth keeps an origin's tokens in the SecretStore. */
export { nativeTokensKey }

/**
 * What earlier builds kept, which ran their own PKCE before the direct client
 * existed: the token set per origin, and the attempt in progress with its
 * PKCE verifier.
 */
export const legacyTokensKey = (origin: string) => `tokens:${origin}`
export const LEGACY_ATTEMPT_KEY = 'signin.attempt'

/** The stored origin, re-checked: a value that is not a Hermes origin is ignored. */
export async function readStoredOrigin(
  keyValue: KeyValueStore,
): Promise<string | undefined> {
  const raw = await keyValue.get(ORIGIN_KEY)
  if (raw === undefined) return undefined
  const parsed = HermesOrigin.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/**
 * Moves an earlier build's sign-in to where NativeAuth reads it, once: the
 * token set goes to NativeAuth's key for the stored origin (unless NativeAuth
 * already has one there) and the old record is deleted, readable or not,
 * unless the Keystore refused the new write (then it stays for a later start). An
 * earlier attempt still in progress holds a PKCE verifier and cannot finish
 * any more (its listener did not survive the update): it is deleted and
 * reported as interrupted.
 */
export async function migrateEarlierSignIn(deps: {
  keyValue: KeyValueStore
  secrets: SecretStore
}): Promise<{ origin: string | undefined; interrupted: boolean }> {
  const origin = await readStoredOrigin(deps.keyValue)
  if (!deps.secrets.available) return { origin, interrupted: false }
  const interrupted = (await deps.secrets.get(LEGACY_ATTEMPT_KEY)) !== undefined
  if (interrupted) await deps.secrets.delete(LEGACY_ATTEMPT_KEY)
  if (origin !== undefined) {
    const legacy = await deps.secrets.get(legacyTokensKey(origin))
    if (legacy !== undefined) {
      const tokens = parseTokens(legacy)
      if (tokens && (await deps.secrets.get(nativeTokensKey(origin))) === undefined)
        await deps.secrets.set(nativeTokensKey(origin), JSON.stringify(tokens))
      // A write the Keystore refused stayed in memory only: keep the old record.
      if (deps.secrets.available) await deps.secrets.delete(legacyTokensKey(origin))
    }
  }
  return { origin, interrupted }
}

function parseTokens(raw: string): wire.NativeTokenResponse | undefined {
  try {
    const parsed = wire.NativeTokenResponse.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
