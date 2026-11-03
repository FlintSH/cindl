import { CindlEvent, type LinkState } from '@cindl/contracts'
import {
  nodeSocketFactory,
  startFakeHermes,
  type FakeHermes,
  type FakeHermesOptions,
} from '@cindl/fixtures/fake-hermes'
import { webCryptoProvider } from '@cindl/hermes-adapter'
import { afterEach, expect } from 'vitest'
import {
  createDirectClient,
  createStore,
  systemClock,
  type ClientStore,
  type DirectClient,
  type DirectClientDeps,
  type KeyValueStore,
  type SecretStore,
} from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

export function memoryKv(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      map.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      map.delete(key)
      return Promise.resolve()
    },
  }
}

export function memorySecrets(): SecretStore & { map: Map<string, string> } {
  return { ...memoryKv(), available: true }
}

export async function fakeHermes(options: FakeHermesOptions = {}): Promise<FakeHermes> {
  const fake = await startFakeHermes(options)
  cleanups.push(async () => {
    expect(
      fake.violations,
      'fake Hermes frames must match the vendored contract',
    ).toEqual([])
    await fake.close()
  })
  return fake
}

export interface Harness {
  fake: FakeHermes
  client: DirectClient
  events: CindlEvent[]
  store: ClientStore
  kv: ReturnType<typeof memoryKv>
  secrets: ReturnType<typeof memorySecrets>
  waitFor<T>(check: () => T | undefined | false, ms?: number): Promise<T>
  rpcCalls(name: string): number
}

const initialLink: LinkState = {
  phase: 'unconfigured',
  since: '2026-01-01T00:00:00.000Z',
  connectionEpoch: 0,
}

export async function harness(
  options: {
    fake?: FakeHermes
    kv?: ReturnType<typeof memoryKv>
    secrets?: ReturnType<typeof memorySecrets>
    deps?: Partial<DirectClientDeps>
    signIn?: boolean
  } = {},
): Promise<Harness> {
  const fake = options.fake ?? (await fakeHermes())
  const kv = options.kv ?? memoryKv()
  const secrets = options.secrets ?? memorySecrets()
  const client = createDirectClient({
    origin: fake.origin,
    auth: 'native-pkce',
    fetch: (url, init) => fetch(url, init),
    socketFactory: nodeSocketFactory(),
    clock: systemClock,
    kv,
    secrets,
    crypto: webCryptoProvider(),
    authorizer: {
      async authorize(buildUrl) {
        const response = await fetch(buildUrl('http://127.0.0.1:53682/callback'), {
          redirect: 'manual',
        })
        return response.headers.get('location') ?? ''
      },
    },
    connection: { backoff: { initialMs: 20, maxMs: 100 } },
    random: () => 0.5,
    ...options.deps,
  })
  const events: CindlEvent[] = []
  const store = createStore(initialLink)
  client.subscribe((event) => {
    events.push(event)
    store.dispatch(event)
  })
  cleanups.push(() => {
    client.stop()
    // Every event the client emitted must satisfy the v2 contract.
    for (const event of events) CindlEvent.parse(event)
  })
  await client.start()
  if (options.signIn !== false) await client.call('auth.signIn', { origin: fake.origin })
  const waitFor = async <T>(
    check: () => T | undefined | false,
    ms = 5_000,
  ): Promise<T> => {
    const started = Date.now()
    for (;;) {
      const value = check()
      if (value !== undefined && value !== false) return value
      if (Date.now() - started > ms) throw new Error('condition not met in time')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const harnessed: Harness = {
    fake,
    client,
    events,
    store,
    kv,
    secrets,
    waitFor,
    rpcCalls: (name) =>
      fake.calls.filter((c) => c.kind === 'rpc' && c.name === name).length,
  }
  if (options.signIn !== false)
    await waitFor(() => store.getState().link.phase === 'online')
  return harnessed
}
