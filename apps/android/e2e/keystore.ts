import { createHash } from 'node:crypto'

/**
 * Evidence of where the app keeps the Hermes tokens, read from its private
 * storage on the emulator (adbd as root on the AOSP image). expo-secure-store
 * keeps each value in shared_prefs/SecureStore.xml, under
 * `<keystore alias>-<key>`, as JSON from AES/GCM with a key held in the
 * Android Keystore (`ct`, `iv`, `scheme: "aes"`, `keystoreAlias`). Every file
 * of the app's storage, and the device log, is searched for the token values
 * the server issued. Only facts about the value leave the device: never the
 * value, the ciphertext or a token.
 */

const ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  amp: '&',
}

const unescapeXml = (text: string) =>
  text.replace(
    /&(quot|apos|lt|gt|amp|#(\d+)|#x([0-9a-fA-F]+));/g,
    (all, name, dec, hex) =>
      dec
        ? String.fromCodePoint(Number(dec))
        : hex
          ? String.fromCodePoint(Number.parseInt(String(hex), 16))
          : (ENTITIES[String(name)] ?? all),
  )

/** The `<string name="…">…</string>` entries of an Android SharedPreferences file. */
export function sharedPreferences(xml: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const match of xml.matchAll(/<string name="([^"]*)">([^<]*)<\/string>/g))
    entries.set(unescapeXml(match[1] ?? ''), unescapeXml(match[2] ?? ''))
  return entries
}

/** The paths of `files` whose text holds any of `tokens` (app files, device logs). */
export function holdingTokens(
  files: ReadonlyMap<string, string>,
  tokens: readonly string[],
): string[] {
  const values = tokens.filter((token) => token.length > 0)
  return [...files]
    .filter(([, content]) => values.some((token) => content.includes(token)))
    .map(([path]) => path)
}

/** Where expo-secure-store keeps its values, under the app's data directory. */
export const SECURE_STORE_FILE = '/shared_prefs/SecureStore.xml'

export interface TokenStorage {
  /** The token set has an entry in SecureStore.xml. */
  stored: boolean
  /** That entry is AES ciphertext with an IV, from a Keystore key alias. */
  encrypted: boolean
  scheme: string | undefined
  keystoreAlias: string | undefined
  /** Paths of the files read and searched. */
  searched: string[]
  /** How many token values the server issued, all searched for. */
  tokensSearched: number
  /** Files holding an issued token value, or a token set's field names, in plain text. */
  plaintextIn: string[]
  plaintext: boolean
  /** A short hash of the ciphertext, to tell a re-encrypted (refreshed) value apart. */
  fingerprint: string | undefined
}

/**
 * What the device's storage shows for the token set stored under `tokenKey`
 * (the app's secure-store key for NativeAuth's key). `files` is every file of
 * the app's private storage by path, read as text (binary files too: a token
 * is ASCII, so it survives the decoding); `tokens` the values the server
 * issued.
 */
export function tokenStorage(input: {
  files: ReadonlyMap<string, string>
  tokenKey: string
  tokens: readonly string[]
}): TokenStorage {
  const xml =
    [...input.files].find(([path]) => path.endsWith(SECURE_STORE_FILE))?.[1] ?? ''
  const entry = [...sharedPreferences(xml)].find(([name]) =>
    name.endsWith(`-${input.tokenKey}`),
  )?.[1]
  let item: Record<string, unknown> | undefined
  try {
    const parsed: unknown = entry === undefined ? undefined : JSON.parse(entry)
    item =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : undefined
  } catch {
    item = undefined
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const ciphertext = text(item?.ct)
  const scheme = text(item?.scheme)
  const keystoreAlias = text(item?.keystoreAlias)
  const tokens = input.tokens.filter((token) => token.length > 0)
  const fieldNames = /access_token|refresh_token/
  const withToken = new Set(holdingTokens(input.files, tokens))
  const plaintextIn = [...input.files]
    .filter(([path, content]) => withToken.has(path) || fieldNames.test(content))
    .map(([path]) => path)
  return {
    stored: entry !== undefined,
    encrypted:
      ciphertext !== undefined &&
      ciphertext.length > 0 &&
      text(item?.iv) !== undefined &&
      scheme === 'aes' &&
      keystoreAlias !== undefined,
    scheme,
    keystoreAlias,
    searched: [...input.files.keys()],
    tokensSearched: tokens.length,
    plaintextIn,
    plaintext: plaintextIn.length > 0,
    fingerprint:
      ciphertext === undefined
        ? undefined
        : createHash('sha256').update(ciphertext).digest('hex').slice(0, 12),
  }
}
