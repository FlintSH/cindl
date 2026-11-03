import type { SecretStore } from '@cindl/client-core'
import { createSerialQueue, readJsonFile, writeFileAtomic } from './files.ts'

/** The subset of Electron's `safeStorage` (async API, Electron 45) Cindl uses. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }>
  getSelectedStorageBackend?(): string
}

export type TokenPersistence = 'os-keyring' | 'memory-only'

/**
 * `available` is always true for these stores: they never write plaintext,
 * and keep in memory what the keyring cannot protect. Callers (the adapter's
 * NativeAuth) therefore always hand them tokens and deletes, so a delete
 * reaches the disk whatever the keyring does, and tokens outlive the client
 * that wrote them. Whether they survive a restart is `persistence`.
 */
export interface DesktopSecretStore extends SecretStore {
  readonly persistence: TokenPersistence
  /** Why secrets stay in memory, when they do. */
  readonly reason: string | undefined
  /** Called once if the keyring stops encrypting while Cindl runs. */
  onDegrade(listener: () => void): () => void
}

/**
 * Linux backends that do not protect anything: `basic_text` encrypts with a
 * hard-coded password, `unknown` means no backend was selected.
 */
const UNPROTECTED_BACKENDS: ReadonlySet<string> = new Set(['basic_text', 'unknown'])
/** Chromium's Linux ciphertext prefix for its hard-coded fallback key. */
const BUILT_IN_KEY_PREFIX = 'v10'

export async function probeSafeStorage(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): Promise<{ usable: true } | { usable: false; reason: string }> {
  let available: boolean
  try {
    available = await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available)
    return {
      usable: false,
      reason:
        'The operating system offers no encryption to Cindl (Electron safeStorage).',
    }
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
    if (UNPROTECTED_BACKENDS.has(backend))
      return {
        usable: false,
        reason: `No OS keyring was found (Electron safeStorage backend "${backend}" is not real encryption).`,
      }
    // The backend name is not proof: when the keyring cannot be reached,
    // Chromium encrypts with its built-in key and marks the result "v10".
    try {
      const probe = await safeStorage.encryptStringAsync('cindl-keyring-probe')
      if (probe.subarray(0, 3).toString('latin1') === BUILT_IN_KEY_PREFIX)
        return {
          usable: false,
          reason: `The OS keyring (${backend}) could not be reached, so Electron safeStorage fell back to its built-in key.`,
        }
    } catch {
      return { usable: false, reason: 'The OS keyring refused to encrypt.' }
    }
  }
  return { usable: true }
}

interface SecretFile {
  version: 1
  /** key -> base64 ciphertext from safeStorage. Never plaintext. */
  entries: Record<string, string>
}

function parseSecretFile(value: unknown): SecretFile {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { entries?: unknown }).entries === 'object' &&
    (value as { entries?: unknown }).entries !== null
  ) {
    const entries = Object.create(null) as Record<string, string>
    for (const [key, cipher] of Object.entries((value as SecretFile).entries))
      if (typeof cipher === 'string') entries[key] = cipher
    return { version: 1, entries }
  }
  return { version: 1, entries: Object.create(null) as Record<string, string> }
}

/**
 * Each record carries its key inside the ciphertext. Keys name the Hermes
 * origin (the adapter's token key does), so a record copied under another
 * key on disk, to send its tokens elsewhere, does not decrypt to anything.
 */
const seal = (key: string, value: string) => JSON.stringify({ key, value })

function unseal(key: string, plain: string): string | undefined {
  try {
    const record = JSON.parse(plain) as { key?: unknown; value?: unknown } | null
    return record?.key === key && typeof record.value === 'string'
      ? record.value
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Secrets in memory only. Used when the OS cannot encrypt: nothing is ever
 * written to disk, so tokens are forgotten when Cindl quits. It reports
 * `available` all the same: it never writes plaintext, and holding the tokens
 * here (rather than in the client that signed in) lets them outlive that
 * client, so a failed switch can restart the previous session.
 */
export function createMemorySecretStore(reason: string): DesktopSecretStore {
  const values = new Map<string, string>()
  return {
    available: true,
    persistence: 'memory-only',
    reason,
    // Memory-only from the start: the startup notice already says so.
    onDegrade: () => () => undefined,
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}

/**
 * Electron `safeStorage` secret store. Ciphertext lives in one owner-only
 * JSON file in userData. When encryption is unavailable (or the Linux backend
 * is the plaintext fallback), it degrades to `createMemorySecretStore`: it
 * never writes a token in plaintext. If the keyring refuses to encrypt later,
 * the store turns memory-only for the rest of the run: that value and every
 * later one stay in memory, each one's older ciphertext is removed from disk,
 * and `onDegrade` listeners hear it once. Deletes always reach the disk.
 */
export async function createSecretStore(options: {
  safeStorage: SafeStorageLike
  file: string
  platform: NodeJS.Platform
  onWarning?: (message: string, detail?: unknown) => void
}): Promise<DesktopSecretStore> {
  const probe = await probeSafeStorage(options.safeStorage, options.platform)
  if (!probe.usable) return createMemorySecretStore(probe.reason)

  const { safeStorage, file } = options
  const queue = createSerialQueue()
  const memory = new Map<string, string>()
  let cache: SecretFile | undefined
  let degradedReason: string | undefined
  const degradeListeners = new Set<() => void>()

  const load = async (): Promise<SecretFile> => {
    if (!cache) {
      try {
        cache = parseSecretFile(await readJsonFile(file))
      } catch (error) {
        options.onWarning?.('Ignoring an unreadable secret store file', error)
        cache = { version: 1, entries: Object.create(null) as Record<string, string> }
      }
    }
    return cache
  }
  const save = (data: SecretFile) => writeFileAtomic(file, `${JSON.stringify(data)}\n`)
  /** Keep `value` in memory, and drop the ciphertext it replaces. */
  const keepInMemory = async (data: SecretFile, key: string, value: string) => {
    memory.set(key, value)
    if (key in data.entries) {
      delete data.entries[key]
      await save(data)
    }
  }

  const store: DesktopSecretStore = {
    available: true,
    get persistence(): TokenPersistence {
      return degradedReason === undefined ? 'os-keyring' : 'memory-only'
    },
    get reason() {
      return degradedReason
    },
    onDegrade(listener) {
      degradeListeners.add(listener)
      return () => degradeListeners.delete(listener)
    },
    get: (key) =>
      queue(async () => {
        if (memory.has(key)) return memory.get(key)
        const cipher = (await load()).entries[key]
        if (cipher === undefined) return undefined
        try {
          const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
            Buffer.from(cipher, 'base64'),
          )
          const value = unseal(key, result)
          if (value === undefined) {
            options.onWarning?.('A stored secret does not belong to its key; ignoring it')
            return undefined
          }
          // Never written once degraded; a refused re-encryption keeps the old ciphertext.
          if (shouldReEncrypt && degradedReason === undefined) {
            try {
              const cipher = await safeStorage.encryptStringAsync(result)
              const data = await load()
              data.entries[key] = cipher.toString('base64')
              await save(data)
            } catch (error) {
              options.onWarning?.('A stored secret could not be re-encrypted', error)
            }
          }
          return value
        } catch (error) {
          options.onWarning?.('A stored secret could not be decrypted', error)
          return undefined
        }
      }),
    set: (key, value) =>
      queue(async () => {
        const data = await load()
        // Memory-only once degraded, even if the keyring works again: the
        // warning says tokens are forgotten when Cindl quits, and they are.
        if (degradedReason !== undefined) return keepInMemory(data, key, value)
        let cipher: string
        try {
          cipher = (await safeStorage.encryptStringAsync(seal(key, value))).toString(
            'base64',
          )
        } catch (error) {
          options.onWarning?.(
            'The OS keyring refused to encrypt; keeping tokens in memory until Cindl quits',
            error,
          )
          degradedReason = 'The OS keyring refused to encrypt Cindl’s tokens.'
          await keepInMemory(data, key, value)
          for (const listener of [...degradeListeners]) listener()
          return
        }
        memory.delete(key)
        data.entries[key] = cipher
        await save(data)
      }),
    delete: (key) =>
      queue(async () => {
        memory.delete(key)
        const data = await load()
        if (!(key in data.entries)) return
        delete data.entries[key]
        await save(data)
      }),
  }
  return store
}
