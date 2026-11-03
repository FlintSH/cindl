import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSecretStore,
  probeSafeStorage,
  type SafeStorageLike,
} from '../src/main/platform/secret-store.ts'

const TOKEN = 'hermes-access-token-PLAINTEXT-0123456789'

/** Reversible stand-in for OS encryption: never contains the plaintext. */
function fakeSafeStorage(
  options: {
    available?: boolean
    backend?: string
    failEncrypt?: boolean
    reEncrypt?: boolean
  } = {},
): SafeStorageLike & { encrypted: number } {
  const fake = {
    encrypted: 0,
    isAsyncEncryptionAvailable: () => Promise.resolve(options.available ?? true),
    getSelectedStorageBackend: () => options.backend ?? 'gnome_libsecret',
    encryptStringAsync: (plain: string) => {
      if (options.failEncrypt) return Promise.reject(new Error('keyring locked'))
      fake.encrypted += 1
      return Promise.resolve(
        Buffer.from(`enc:${Buffer.from(plain).reverse().toString('base64')}`),
      )
    },
    decryptStringAsync: (cipher: Buffer) => {
      const text = cipher.toString()
      if (!text.startsWith('enc:')) return Promise.reject(new Error('bad ciphertext'))
      return Promise.resolve({
        result: Buffer.from(text.slice(4), 'base64').reverse().toString(),
        shouldReEncrypt: options.reEncrypt ?? false,
      })
    },
  }
  return fake
}

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cindl-secrets-'))
  file = path.join(dir, 'secrets.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Every byte Cindl wrote under the test directory. */
const everythingOnDisk = () =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n')

describe('safeStorage probe', () => {
  it('treats Linux basic_text and unknown backends as unavailable', async () => {
    for (const backend of ['basic_text', 'unknown'])
      expect((await probeSafeStorage(fakeSafeStorage({ backend }), 'linux')).usable).toBe(
        false,
      )
    expect((await probeSafeStorage(fakeSafeStorage(), 'linux')).usable).toBe(true)
    expect(
      (await probeSafeStorage(fakeSafeStorage({ backend: 'basic_text' }), 'darwin'))
        .usable,
    ).toBe(true)
  })

  it('treats ciphertext from the built-in key as no keyring, whatever the backend says', async () => {
    const fallback = {
      ...fakeSafeStorage({ backend: 'gnome_libsecret' }),
      encryptStringAsync: () => Promise.resolve(Buffer.from('v10\u0001\u0002ciphertext')),
    }
    const probe = await probeSafeStorage(fallback, 'linux')
    expect(probe.usable).toBe(false)
    const store = await createSecretStore({
      safeStorage: fallback,
      file,
      platform: 'linux',
    })
    expect(store.persistence).toBe('memory-only')
    await store.set('token', TOKEN)
    expect(readdirSync(dir)).toEqual([])
  })

  it('treats a probe the keyring refuses as unavailable', async () => {
    const probe = await probeSafeStorage(fakeSafeStorage({ failEncrypt: true }), 'linux')
    expect(probe.usable).toBe(false)
  })

  it('treats a failing availability check as unavailable', async () => {
    const broken = {
      ...fakeSafeStorage(),
      isAsyncEncryptionAvailable: () => Promise.reject(new Error('dbus')),
    }
    expect((await probeSafeStorage(broken, 'linux')).usable).toBe(false)
  })
})

describe('secret store without OS encryption', () => {
  it.each([
    ['encryption unavailable', fakeSafeStorage({ available: false })],
    ['the basic_text fallback', fakeSafeStorage({ backend: 'basic_text' })],
  ])(
    'keeps tokens in memory only with %s and never writes them',
    async (_label, safeStorage) => {
      const store = await createSecretStore({ safeStorage, file, platform: 'linux' })
      // Usable: callers hand it tokens and deletes (it never writes plaintext);
      // persistence says they do not survive a restart.
      expect(store.available).toBe(true)
      expect(store.persistence).toBe('memory-only')
      expect(store.reason).toBeTruthy()
      await store.set('hermes.native-tokens:https://hermes.example.test', TOKEN)
      expect(await store.get('hermes.native-tokens:https://hermes.example.test')).toBe(
        TOKEN,
      )
      expect(readdirSync(dir)).toEqual([])
      expect((safeStorage as { encrypted: number }).encrypted).toBe(0)
      // A restart forgets them.
      const restarted = await createSecretStore({ safeStorage, file, platform: 'linux' })
      expect(
        await restarted.get('hermes.native-tokens:https://hermes.example.test'),
      ).toBeUndefined()
      await store.delete('hermes.native-tokens:https://hermes.example.test')
      expect(
        await store.get('hermes.native-tokens:https://hermes.example.test'),
      ).toBeUndefined()
    },
  )
})

describe('secret store with OS encryption', () => {
  it('persists ciphertext only, in an owner-only file', async () => {
    const safeStorage = fakeSafeStorage()
    const store = await createSecretStore({ safeStorage, file, platform: 'linux' })
    expect(store.persistence).toBe('os-keyring')
    await store.set('token', TOKEN)
    expect(everythingOnDisk()).not.toContain(TOKEN)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const restarted = await createSecretStore({ safeStorage, file, platform: 'linux' })
    expect(await restarted.get('token')).toBe(TOKEN)
    await restarted.delete('token')
    expect(await restarted.get('token')).toBeUndefined()
    expect(everythingOnDisk()).not.toContain('enc:')
  })

  it('re-encrypts when the OS asks for it', async () => {
    const first = await createSecretStore({
      safeStorage: fakeSafeStorage(),
      file,
      platform: 'linux',
    })
    await first.set('token', TOKEN)
    const rotating = fakeSafeStorage({ reEncrypt: true })
    const store = await createSecretStore({
      safeStorage: rotating,
      file,
      platform: 'linux',
    })
    const afterProbe = rotating.encrypted
    expect(await store.get('token')).toBe(TOKEN)
    expect(rotating.encrypted - afterProbe).toBe(1)
  })

  it('falls back to memory, without plaintext on disk, when encryption fails', async () => {
    const working = await createSecretStore({
      safeStorage: fakeSafeStorage(),
      file,
      platform: 'linux',
    })
    await working.set('token', 'older-token-value-9876543210')
    // Encryption works for the startup probe, then the keyring locks.
    const unlocked = fakeSafeStorage()
    let calls = 0
    const failing = {
      ...unlocked,
      encryptStringAsync: (plain: string) =>
        ++calls === 1
          ? unlocked.encryptStringAsync(plain)
          : Promise.reject(new Error('keyring locked')),
    }
    const store = await createSecretStore({
      safeStorage: failing,
      file,
      platform: 'linux',
    })
    expect(store.persistence).toBe('os-keyring')
    await store.set('token', TOKEN)
    expect(store.persistence).toBe('memory-only')
    expect(await store.get('token')).toBe(TOKEN)
    const disk = everythingOnDisk()
    expect(disk).not.toContain(TOKEN)
    // The stale persisted value is gone too, so it cannot resurface after a restart.
    expect(JSON.parse(disk) as unknown).toEqual({ version: 1, entries: {} })
  })

  it('binds each record to its key, so a copy under another key reads as nothing', async () => {
    const store = await createSecretStore({
      safeStorage: fakeSafeStorage(),
      file,
      platform: 'linux',
    })
    const key = 'cindl.hermes.native-tokens.v1|https://hermes.example.test'
    await store.set(key, TOKEN)
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      entries: Record<string, string>
    }
    const other = 'cindl.hermes.native-tokens.v1|https://evil.example.test'
    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: { [other]: data.entries[key] } }),
    )
    const reopened = await createSecretStore({
      safeStorage: fakeSafeStorage(),
      file,
      platform: 'linux',
    })
    expect(await reopened.get(other)).toBeUndefined()
  })

  it('ignores a corrupt or tampered file instead of crashing', async () => {
    writeFileSync(file, '{not json')
    const store = await createSecretStore({
      safeStorage: fakeSafeStorage(),
      file,
      platform: 'linux',
    })
    expect(await store.get('token')).toBeUndefined()
    writeFileSync(file, JSON.stringify({ version: 1, entries: { token: 'garbage' } }))
    const tampered = await createSecretStore({
      safeStorage: fakeSafeStorage(),
      file,
      platform: 'linux',
    })
    expect(await tampered.get('token')).toBeUndefined()
  })
})
