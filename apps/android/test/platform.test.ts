/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto'
import type { WebSocketLike } from '@cindl/client-core'
import {
  base64Url,
  createPkcePair,
  GATEWAY_SUBPROTOCOL,
  ticketSubprotocol,
} from '@cindl/hermes-adapter'
import { describe, expect, it } from 'vitest'
import { createCryptoProvider } from '../src/platform/crypto.ts'
import { createKeyValueStore } from '../src/platform/keyValueStore.ts'
import { isAllowedHermesUrl, normalizeOrigin } from '../src/platform/origin.ts'
import {
  createPreferencesStore,
  defaultPreferences,
  parsePreferences,
} from '../src/platform/preferences.ts'
import {
  createSecretStore,
  MAX_SECRET_LENGTH,
  secureStoreKey,
} from '../src/platform/secretStore.ts'
import { createWebSocketFactory } from '../src/platform/webSocket.ts'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => Promise.resolve(data.get(key) ?? null),
    setItem: (key: string, value: string) => Promise.resolve(void data.set(key, value)),
    removeItem: (key: string) => Promise.resolve(void data.delete(key)),
    getItemAsync: (key: string) => Promise.resolve(data.get(key) ?? null),
    setItemAsync: (key: string, value: string) =>
      Promise.resolve(void data.set(key, value)),
    deleteItemAsync: (key: string) => Promise.resolve(void data.delete(key)),
  }
}

describe('Hermes origin (sign-in address)', () => {
  it.each([
    ['hermes.example.test', 'https://hermes.example.test'],
    ['  https://Hermes.Example.test/  ', 'https://hermes.example.test'],
    ['https://hermes.example.test:8443', 'https://hermes.example.test:8443'],
    ['http://127.0.0.1:9119', 'http://127.0.0.1:9119'],
    ['http://[::1]:9119', 'http://[::1]:9119'],
  ])('accepts %s as %s', (input, origin) => {
    expect(normalizeOrigin(input)).toEqual({ ok: true, origin })
  })

  it.each([
    ['', 'Enter the address'],
    ['http://hermes.example.test', 'Use https://'],
    ['http://localhost:9119', 'Use https://'],
    ['http://192.0.2.10:9119', 'Use https://'],
    ['ftp://hermes.example.test', 'Use an https:// address'],
    ['https://owner:secret@hermes.example.test', 'user name or password'],
    ['https://hermes.example.test/app', 'without a path'],
    ['https://hermes.example.test/?x=1', 'without a path'],
    ['https://hermes.example.test/?', 'without a path'],
    ['https://hermes.example.test/#top', 'without a path'],
    ['https://', 'not a valid address'],
  ])('rejects %s', (input, reason) => {
    const check = normalizeOrigin(input)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain(reason)
  })

  it('allows sockets and requests only to https/wss or loopback', () => {
    expect(isAllowedHermesUrl('wss://hermes.example.test/api/ws')).toBe(true)
    expect(isAllowedHermesUrl('ws://127.0.0.1:9119/api/ws')).toBe(true)
    expect(isAllowedHermesUrl('ws://[::1]:9119/api/ws')).toBe(true)
    expect(isAllowedHermesUrl('ws://hermes.example.test/api/ws')).toBe(false)
    expect(isAllowedHermesUrl('ws://localhost:9119/api/ws')).toBe(false)
    expect(isAllowedHermesUrl('not a url')).toBe(false)
  })
})

describe('secret store on expo-secure-store', () => {
  it('encodes any client key into the charset expo-secure-store accepts, without collisions', () => {
    const keys = [
      'tokens:https://hermes.example.test',
      'tokens:https://hermes.example.test/',
      'é',
      'a.b',
      'a_b',
    ]
    const encoded = keys.map(secureStoreKey)
    for (const key of encoded) expect(key).toMatch(/^[\w.-]+$/)
    expect(new Set(encoded).size).toBe(keys.length)
  })

  it('stores under encoded keys and deletes them', async () => {
    const native = memoryStorage()
    const store = createSecretStore(native, true)
    await store.set('tokens:https://hermes.example.test', '{"access_token":"x"}')
    expect([...native.data.keys()]).toEqual([
      secureStoreKey('tokens:https://hermes.example.test'),
    ])
    expect(await store.get('tokens:https://hermes.example.test')).toBe(
      '{"access_token":"x"}',
    )
    await store.delete('tokens:https://hermes.example.test')
    expect(await store.get('tokens:https://hermes.example.test')).toBeUndefined()
  })

  it('never falls back to plaintext when the device cannot encrypt', async () => {
    const native = memoryStorage()
    const store = createSecretStore(native, false)
    expect(store.available).toBe(false)
    await expect(store.set('k', 'v')).rejects.toMatchObject({ code: 'unavailable' })
    expect(native.data.size).toBe(0)
    expect(await store.get('k')).toBeUndefined()
  })

  it('refuses implausibly large values', async () => {
    const store = createSecretStore(memoryStorage(), true)
    await expect(store.set('k', 'x'.repeat(MAX_SECRET_LENGTH + 1))).rejects.toMatchObject(
      {
        code: 'invalid',
      },
    )
  })
})

describe('key-value store on AsyncStorage', () => {
  it('namespaces keys and maps missing values to undefined', async () => {
    const storage = memoryStorage()
    const store = createKeyValueStore(storage)
    expect(await store.get('outbox')).toBeUndefined()
    await store.set('outbox', '[]')
    expect([...storage.data.keys()]).toEqual(['cindl.kv.outbox'])
    await store.delete('outbox')
    expect(storage.data.size).toBe(0)
  })
})

describe('PKCE over expo-crypto', () => {
  const nodeBacked = createCryptoProvider({
    getRandomBytes: (count) => new Uint8Array(randomBytes(count)),
    digestSha256: (data) => {
      const digest = createHash('sha256').update(data).digest()
      return Promise.resolve(
        digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength),
      )
    },
  })

  it('produces an S256 challenge that matches the verifier', async () => {
    const pair = await createPkcePair(nodeBacked)
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pair.challenge).toBe(
      base64Url(createHash('sha256').update(pair.verifier).digest()),
    )
  })

  it('fails loudly if the random source is short', () => {
    const broken = createCryptoProvider({
      getRandomBytes: () => new Uint8Array(4),
      digestSha256: () => Promise.resolve(new ArrayBuffer(32)),
    })
    expect(() => broken.randomBytes(32)).toThrow()
  })
})

describe('WebSocket factory', () => {
  class FakeSocket implements WebSocketLike {
    static created: Array<{ url: string; protocols: string[] }> = []
    readyState = 0
    protocol = ''
    onopen = null
    onmessage = null
    onclose = null
    onerror = null
    constructor(url: string, protocols: string[]) {
      FakeSocket.created.push({ url, protocols })
    }
    send() {}
    close() {}
  }

  it('passes the gateway and ticket subprotocols through, keeping the ticket out of the URL', () => {
    const factory = createWebSocketFactory(FakeSocket)
    factory('wss://hermes.example.test/api/ws', [
      GATEWAY_SUBPROTOCOL,
      ticketSubprotocol('t1ck3t'),
    ])
    expect(FakeSocket.created).toEqual([
      {
        url: 'wss://hermes.example.test/api/ws',
        protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t1ck3t'],
      },
    ])
  })

  it('refuses cleartext sockets to anything but loopback', () => {
    const factory = createWebSocketFactory(FakeSocket)
    expect(() => factory('ws://hermes.example.test/api/ws', [])).toThrow()
  })
})

describe('preferences', () => {
  it('falls back to defaults for missing or malformed data', () => {
    expect(parsePreferences(undefined)).toEqual(defaultPreferences)
    expect(parsePreferences('{')).toEqual(defaultPreferences)
    expect(parsePreferences('{"theme":"neon"}')).toEqual(defaultPreferences)
    expect(parsePreferences('{"theme":"dark"}')).toEqual({ theme: 'dark' })
  })

  it('updates in memory at once and persists in the background', async () => {
    const storage = memoryStorage()
    const store = createPreferencesStore(createKeyValueStore(storage))
    await store.load()
    let notified = 0
    store.subscribe(() => notified++)
    store.set('theme', 'light')
    expect(store.get().theme).toBe('light')
    expect(notified).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(storage.data.get('cindl.kv.preferences.v1')).toBe('{"theme":"light"}')
  })

  it('keeps working for the session when storage fails', async () => {
    const failing = {
      get: () => Promise.reject(new Error('disk')),
      set: () => Promise.reject(new Error('disk')),
      delete: () => Promise.reject(new Error('disk')),
    }
    const store = createPreferencesStore(failing)
    await store.load()
    expect(store.get()).toEqual(defaultPreferences)
    store.set('theme', 'dark')
    expect(store.get().theme).toBe('dark')
  })
})
