import {
  CindlError,
  CindlEvent,
  type Conversation,
  type ServerRequest,
} from '@cindl/contracts'
import { connectRawClient } from '@cindl/fixtures/fake-hermes'
import { describe, expect, it } from 'vitest'
import { nativeTokensKey, webCryptoProvider } from '@cindl/hermes-adapter'
import {
  createDirectClient,
  createStore,
  entry,
  selectOpenRequests,
  sha256Hex,
  systemClock,
  type KeyValueStore,
} from '../src/index.ts'
import {
  fakeHermes,
  harness,
  memoryKv,
  memorySecrets,
  type Harness,
} from './direct-harness.ts'

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof CindlError ? error.code : String(error)),
  )

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function conversation(h: Harness, title = 'Side (fixture)'): Promise<Conversation> {
  return h.client.call('conversations.create', { title })
}

function assistantText(h: Harness, conversationId: string): string {
  const messages = entry(h.store.getState().messages, conversationId) ?? []
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
}

const requestOf = (h: Harness, requestId: string): ServerRequest | undefined =>
  entry(h.store.getState().requests, requestId)

const online = (h: Harness, epoch?: number) =>
  h.waitFor(
    () =>
      h.store.getState().link.phase === 'online' &&
      (epoch === undefined || h.store.getState().link.connectionEpoch >= epoch),
  )

/** The next turn asks for approval; `outcome` records what Hermes received. */
function approvalScript(
  h: Harness,
  choices: Array<'once' | 'session' | 'always' | 'deny'> = [
    'once',
    'session',
    'always',
    'deny',
  ],
) {
  const outcome: { result?: unknown; done?: boolean } = {}
  h.fake.gateway.script = async (turn) => {
    outcome.result = await turn.approval({ choices: [...choices] })
    outcome.done = true
  }
  return outcome
}

/** Submit a prompt in `target` (or a new conversation) and wait for its request. */
async function openRequest(h: Harness, target?: Conversation) {
  const c = target ?? (await conversation(h))
  await h.client.call('prompt.submit', {
    conversationId: c.id,
    clientId: `p-${c.id}`,
    text: 'export it',
  })
  const request = await h.waitFor(() =>
    selectOpenRequests(h.store.getState()).find((r) => r.conversationId === c.id),
  )
  return { c, request }
}

const approve = (h: Harness, requestId: string, choice: 'once' | 'deny') =>
  h.client.call('request.answer', {
    requestId,
    answer: { kind: 'approval', choice },
  })

/** A prompt this device was sending to `origin` when the app last stopped; returns its outbox key. */
async function seedSendingPrompt(kv: KeyValueStore, origin: string): Promise<string> {
  const key = `cindl.direct.v1|${origin}|outbox`
  await kv.set(
    key,
    JSON.stringify([
      {
        clientId: 'p-was-sending',
        conversationId: 'c-fixture',
        text: 'Send the report (fixture)',
        createdAt: '2026-01-01T00:00:00.000Z',
        state: 'sending',
      },
    ]),
  )
  return key
}

/** Hold the first device-state read for `origin`, which the switch makes. */
function holdDeviceRead(h: Harness, origin: string) {
  const realGet = h.kv.get.bind(h.kv)
  const hold: { armed: boolean; arrived?: () => void; release?: () => void } = {
    armed: true,
  }
  const arrived = new Promise<void>((resolve) => (hold.arrived = resolve))
  h.kv.get = async (key: string) => {
    if (hold.armed && key.includes(`|${origin}|`)) {
      hold.armed = false
      hold.arrived?.()
      await new Promise<void>((resolve) => (hold.release = resolve))
    }
    return realGet(key)
  }
  return { arrived, release: () => hold.release?.() }
}

/** The names of `origin`'s device state the client reads from now on. */
function deviceReads(h: Harness, origin: string): string[] {
  const realGet = h.kv.get.bind(h.kv)
  const reads: string[] = []
  h.kv.get = async (key: string) => {
    if (key.includes(`|${origin}|`)) reads.push(key.slice(key.lastIndexOf('|') + 1))
    return realGet(key)
  }
  return reads
}

/** The store holds what a renderer subscribing now is told. */
function expectStoreMatchesSeed(h: Harness): void {
  const late = createStore({
    phase: 'connecting',
    since: '2026-01-01T00:00:00.000Z',
    connectionEpoch: 0,
  })
  h.client.subscribe((event) => late.dispatch(event))()
  for (const key of ['link', 'capabilities', 'conversations', 'prompts'] as const)
    expect(h.store.getState()[key]).toEqual(late.getState()[key])
}

/**
 * A browser leg whose first sign-in waits until the test fails it; later ones
 * complete. No shipped shell overlaps two sign-ins in the client: desktop's
 * inTurn lets the older attempt settle before the newer one reaches it, and
 * Android refuses a second sign-in. The client keeps them apart all the same.
 */
function heldFirstLeg() {
  const leg: { calls: number; arrived?: () => void; fail?: (error: Error) => void } = {
    calls: 0,
  }
  const arrived = new Promise<void>((resolve) => (leg.arrived = resolve))
  const authorizer = {
    async authorize(buildUrl: (redirectUri: string) => string) {
      if (++leg.calls === 1) {
        leg.arrived?.()
        await new Promise<never>((_, reject) => (leg.fail = reject))
      }
      const response = await fetch(buildUrl('http://127.0.0.1:53682/callback'), {
        redirect: 'manual',
      })
      return response.headers.get('location') ?? ''
    },
  }
  return { authorizer, arrived, fail: (error: Error) => leg.fail?.(error) }
}

/**
 * A browser leg that records what it does: `authorized` counts its
 * authorize() calls, `opened` the pages it opened, `cancelled` its cancel()
 * calls. In `bind` mode it waits before it builds the page's address, as a
 * platform binds its listener; in `wait` mode the page stays open without an
 * answer until cancel(). `answer` mode signs the fixture owner in at once.
 */
function recordingLeg() {
  const state = {
    mode: 'answer' as 'answer' | 'bind' | 'wait',
    authorized: 0,
    opened: [] as string[],
    cancelled: 0,
    /** What the last authorize() came to. */
    settled: Promise.resolve(''),
  }
  let reach: () => void = () => undefined
  let release: () => void = () => undefined
  let failWait: (error: Error) => void = () => undefined
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const authorizer = {
    authorize(buildUrl: (redirectUri: string) => string): Promise<string> {
      state.authorized++
      const mode = state.mode
      state.settled = (async () => {
        if (mode === 'bind') {
          reach()
          await new Promise<void>((resolve) => (release = resolve))
        }
        const url = buildUrl('http://127.0.0.1:53682/callback')
        state.opened.push(url)
        if (mode === 'wait') {
          reach()
          return new Promise<string>((_, reject) => (failWait = reject))
        }
        const response = await fetch(url, { redirect: 'manual' })
        return response.headers.get('location') ?? ''
      })()
      return state.settled
    },
    cancel() {
      state.cancelled++
      failWait(new CindlError('unavailable', 'Sign-in was cancelled.'))
    },
  }
  /** Resolves when the leg reaches its bind hold or its open page. */
  return { state, authorizer, reached, release: () => release() }
}

/** The links the client reports from now on, as `phase@origin`. */
function linkLog(h: Harness): string[] {
  const links: string[] = []
  h.client.subscribe((event) => {
    if (event.type === 'link.changed')
      links.push(`${event.link.phase}@${event.link.server?.origin ?? 'none'}`)
  })
  // Not the link a new subscriber is told at once.
  links.length = 0
  return links
}

describe('direct client: start', () => {
  it('tells its subscriber the link and capabilities when no Hermes is configured', async () => {
    const unreachable = () => Promise.reject(new Error('not used (fixture)'))
    const client = createDirectClient({
      auth: 'native-pkce',
      fetch: unreachable,
      socketFactory: () => {
        throw new Error('not used (fixture)')
      },
      clock: systemClock,
      kv: memoryKv(),
      secrets: memorySecrets(),
      crypto: webCryptoProvider(),
      authorizer: { authorize: unreachable },
      random: () => 0.5,
    })
    const events: CindlEvent[] = []
    client.subscribe((event) => events.push(event))
    await client.start()
    // The link starts out unconfigured; a renderer still needs to hear it once.
    expect(events.map((e) => e.type)).toEqual(['link.changed', 'capabilities.changed'])
    expect(events[0]).toMatchObject({ link: { phase: 'unconfigured' } })
    for (const event of events) CindlEvent.parse(event)
    client.stop()
  })
})

describe('direct client: a fresh client wired into a store that saw another origin', () => {
  it('names its origin before the prompts start() recovers, so the store keeps them', async () => {
    const a = await fakeHermes()
    const kv = memoryKv()
    await seedSendingPrompt(kv, a.origin)
    // Desktop's restart after a failed switch: the renderer's store last saw B.
    const store = createStore({
      phase: 'unconfigured',
      since: '2026-01-01T00:00:00.000Z',
      connectionEpoch: 0,
    })
    store.dispatch({
      type: 'link.changed',
      link: {
        phase: 'signed-out',
        since: '2026-01-01T00:00:00.000Z',
        connectionEpoch: 0,
        auth: 'native-pkce',
        server: { origin: 'https://hermes-b.example.invalid' },
      },
    })
    const h = await harness({ fake: a, kv, store, signIn: false })
    expect(h.events[0]).toMatchObject({
      type: 'link.changed',
      link: { server: { origin: a.origin } },
    })
    expect(entry(h.store.getState().prompts, 'p-was-sending')?.state).toBe('uncertain')
    expectStoreMatchesSeed(h)
  })
})

describe('direct client: signing in to another origin', () => {
  /** Nothing listens on 127.0.0.1:1, so a request there is refused at once. */
  const UNREACHABLE = 'http://127.0.0.1:1'

  it('keeps the working session when a sign-in elsewhere fails, and rethrows', async () => {
    const h = await harness()
    const before = h.store.getState().link
    const handshakes = h.rpcCalls('client.capabilities')
    expect(await codeOf(h.client.call('auth.signIn', { origin: UNREACHABLE }))).toBe(
      'offline',
    )
    // A sign-in the owner cancels on another Hermes fails the same way.
    const other = await fakeHermes({ nativeSignIn: 'deny' })
    expect(await codeOf(h.client.call('auth.signIn', { origin: other.origin }))).not.toBe(
      'resolved',
    )
    const link = h.store.getState().link
    expect(link).toMatchObject({
      phase: 'online',
      connectionEpoch: before.connectionEpoch,
    })
    expect(link.server?.origin).toBe(h.fake.origin)
    expect(link.lastError).toBeUndefined()
    // The same connection carries on: no reconnect, and calls still work.
    expect(h.rpcCalls('client.capabilities')).toBe(handshakes)
    expect(await h.client.call('conversations.list', {})).toBeDefined()
  })

  it("reads none of A's device state again, whether the sign-in elsewhere fails or not", async () => {
    const h = await harness()
    // A prompt saved as sending that A's client does not hold as such.
    await seedSendingPrompt(h.kv, h.fake.origin)
    const readsA = deviceReads(h, h.fake.origin)
    const other = await fakeHermes({ nativeSignIn: 'deny' })
    expect(await codeOf(h.client.call('auth.signIn', { origin: other.origin }))).not.toBe(
      'resolved',
    )
    // Still on A, which shows no such prompt.
    expect(entry(h.store.getState().prompts, 'p-was-sending')).toBeUndefined()
    const b = await fakeHermes()
    await h.client.call('auth.signIn', { origin: b.origin })
    expect(readsA).toEqual([])
  })

  it('switches only once the new sign-in succeeds', async () => {
    const h = await harness()
    const other = await fakeHermes()
    await h.client.call('auth.signIn', { origin: other.origin })
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === other.origin,
    )
    await h.waitFor(() => h.fake.gateway.connections.size === 0)
  })

  it("keeps B's recovered prompts when a sign-in without a session switches to B", async () => {
    const h = await harness({ signIn: false })
    const b = await fakeHermes()
    const outboxKey = await seedSendingPrompt(h.kv, b.origin)
    const links = linkLog(h)
    await h.client.call('auth.signIn', { origin: b.origin })
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === b.origin,
    )
    // The link named B before B's prompts came, so the store kept them.
    expect(entry(h.store.getState().prompts, 'p-was-sending')?.state).toBe('uncertain')
    expect(JSON.parse(h.kv.map.get(outboxKey) ?? '[]')).toMatchObject([
      { clientId: 'p-was-sending', state: 'uncertain' },
    ])
    expect(links[0]).toBe(`connecting@${b.origin}`)
    expect(new Set(links)).toEqual(
      new Set([`connecting@${b.origin}`, `online@${b.origin}`]),
    )
  })

  it("asks B nothing before it has read B's device state", async () => {
    const h = await harness({ signIn: false })
    const b = await fakeHermes()
    const read = holdDeviceRead(h, b.origin)
    const signingIn = h.client.call('auth.signIn', { origin: b.origin })
    await read.arrived
    await pause(100)
    expect(b.calls.filter((c) => c.kind === 'rest')).toEqual([])
    read.release()
    await signingIn
  })

  it('lets a stop() during the switch hold: no browser, and nothing connects', async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const read = holdDeviceRead(h, b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await read.arrived
    h.client.stop()
    read.release()
    // Withdrawn before its browser leg, the sign-in fails; the link says so for B.
    expect(await signingIn).toBe('unavailable')
    expect(browser.state.authorized).toBe(0)
    await pause(100)
    expect(h.store.getState().link).toMatchObject({
      phase: 'offline',
      server: { origin: b.origin },
    })
    expect(b.calls.filter((c) => c.kind === 'ws')).toHaveLength(0)
    // Nothing was stored, so the next start finds B signed out.
    await h.client.start()
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'signed-out' &&
        h.store.getState().link.server?.origin === b.origin,
    )
  })

  it('keeps a failure off the link when a stop() came first', async () => {
    const h = await harness({ signIn: false })
    const b = await fakeHermes()
    const status = b.holdNextRest('GET /api/status')
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await status.arrived
    h.client.stop()
    status.release({ status: 500, body: { detail: 'restarting (fixture)' } })
    // The sign-in still fails to its caller, but the link stays the stop()'s.
    expect(await signingIn).toBe('internal')
    expect(h.store.getState().link).toMatchObject({
      phase: 'offline',
      server: { origin: b.origin },
    })
    expect(h.store.getState().link.lastError).toBeUndefined()
  })

  it("keeps an older sign-in's failure off a newer one's link", async () => {
    const leg = heldFirstLeg()
    const h = await harness({ signIn: false, deps: { authorizer: leg.authorizer } })
    const b = await fakeHermes()
    const c = await fakeHermes()
    const first = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await leg.arrived
    const statusC = c.holdNextRest('GET /api/status')
    const second = h.client.call('auth.signIn', { origin: c.origin })
    await statusC.arrived
    leg.fail(new Error('browser closed (fixture)'))
    expect(await first).not.toBe('resolved')
    // C's sign-in is still under way, and its link shows nothing of B's failure.
    expect(h.store.getState().link).toMatchObject({
      phase: 'connecting',
      server: { origin: c.origin },
    })
    expect(h.store.getState().link.lastError).toBeUndefined()
    statusC.release()
    await second
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === c.origin,
    )
  })

  it("keeps an older sign-in's Hermes version off a newer one's failed link", async () => {
    const leg = heldFirstLeg()
    const h = await harness({ signIn: false, deps: { authorizer: leg.authorizer } })
    const b = await fakeHermes({ version: '9.9.9-b' })
    const c = await fakeHermes()
    const first = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await leg.arrived
    const statusC = c.holdNextRest('GET /api/status')
    const second = codeOf(h.client.call('auth.signIn', { origin: c.origin }))
    await statusC.arrived
    leg.fail(new Error('browser closed (fixture)'))
    expect(await first).not.toBe('resolved')
    // C does not answer, so its failed link has no version to show: none of B's.
    statusC.release({ status: 500, body: { detail: 'restarting (fixture)' } })
    expect(await second).not.toBe('resolved')
    expect(h.store.getState().link.server).toEqual({ origin: c.origin })
  })

  it('ends a failed first sign-in signed out with the error, not connecting', async () => {
    const fake = await fakeHermes({ nativeSignIn: 'deny' })
    const h = await harness({ fake, signIn: false })
    const refused = await codeOf(h.client.call('auth.signIn', { origin: fake.origin }))
    expect(refused).not.toBe('resolved')
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      lastError: { code: refused },
    })
    expect(await codeOf(h.client.call('auth.signIn', { origin: UNREACHABLE }))).toBe(
      'offline',
    )
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      lastError: { code: 'offline' },
      server: { origin: UNREACHABLE },
    })
  })
})

describe('direct client: signing in again to the same origin', () => {
  it('reads none of its device state again, so a saved copy cannot replace what it holds', async () => {
    const h = await harness()
    await h.client.call('auth.signOut', {})
    // A prompt saved as sending that this client does not hold as such, as a
    // failed outbox write can leave one behind.
    await seedSendingPrompt(h.kv, h.fake.origin)
    const reads = deviceReads(h, h.fake.origin)
    await h.client.call('auth.signIn', { origin: h.fake.origin })
    await online(h)
    expect(reads).toEqual([])
    expect(entry(h.store.getState().prompts, 'p-was-sending')).toBeUndefined()
  })
})

describe('direct client: the sign-in an origin switch leaves behind', () => {
  const REFRESH = 'POST /auth/native/refresh'
  const UNREACHABLE = 'http://127.0.0.1:1'

  /** Signed in to A, with the probes that follow sign-in finished. */
  async function onA() {
    const a = await fakeHermes()
    const h = await harness({ fake: a })
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    return { a, h, keyA: nativeTokensKey(a.origin) }
  }

  /**
   * A REST call on A whose token refresh is held at the fake until `release`:
   * A's clock passes the access token's lifetime, so the call gets a 401 and
   * refreshes once.
   */
  async function heldRefresh(h: Harness, a: Harness['fake']) {
    a.advance(13 * 3600 * 1000)
    const held = a.holdNextRest(REFRESH)
    const call = h.client.call('memory.overview', {}).catch(() => undefined)
    await held.arrived
    return { held, call }
  }

  it('never lets a refresh for the origin it left write that sign-in back', async () => {
    const { a, h, keyA } = await onA()
    const b = await fakeHermes()
    const { held, call } = await heldRefresh(h, a)
    await h.client.call('auth.signIn', { origin: b.origin })
    const keyB = nativeTokensKey(b.origin)
    const recordB = h.secrets.map.get(keyB)
    expect(recordB).toBeDefined()
    // The platform deletes the record of the Hermes it left.
    await h.secrets.delete(keyA)
    held.release()
    await call
    expect(h.secrets.map.has(keyA)).toBe(false)
    expect(h.secrets.map.get(keyB)).toBe(recordB)
    expect(h.store.getState().link.server?.origin).toBe(b.origin)
  })

  it('never lets a late refresh overwrite the same origin signed in again', async () => {
    const { a, h, keyA } = await onA()
    const b = await fakeHermes()
    const { held, call } = await heldRefresh(h, a)
    await h.client.call('auth.signIn', { origin: b.origin })
    await h.secrets.delete(keyA)
    // Back to A with a fresh sign-in: the same key, new tokens.
    await h.client.call('auth.signIn', { origin: a.origin })
    const fresh = h.secrets.map.get(keyA)
    expect(fresh).toBeDefined()
    held.release()
    await call
    expect(h.secrets.map.get(keyA)).toBe(fresh)
  })

  it('never lets a late refusal delete the same origin signed in again', async () => {
    const { a, h, keyA } = await onA()
    const b = await fakeHermes()
    const { held, call } = await heldRefresh(h, a)
    await h.client.call('auth.signIn', { origin: b.origin })
    await h.secrets.delete(keyA)
    await h.client.call('auth.signIn', { origin: a.origin })
    const fresh = h.secrets.map.get(keyA)
    // The left sign-in's refresh is refused late, as an expired session would be.
    held.release({
      status: 401,
      body: { error: 'session_expired', detail: 'expired (fixture)' },
    })
    await call
    expect(h.secrets.map.get(keyA)).toBe(fresh)
  })

  it('lets a refresh in flight store when the switch fails', async () => {
    const { a, h, keyA } = await onA()
    const before = h.secrets.map.get(keyA)
    const { held, call } = await heldRefresh(h, a)
    expect(await codeOf(h.client.call('auth.signIn', { origin: UNREACHABLE }))).toBe(
      'offline',
    )
    held.release()
    await call
    // A is still the session: its rotated tokens were kept.
    const after = h.secrets.map.get(keyA)
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    expect(h.store.getState().link).toMatchObject({ phase: 'online' })
    expect(h.store.getState().link.server?.origin).toBe(a.origin)
  })

  it('keeps a refresh when the same origin is signed in to again, which is no switch', async () => {
    const { a, h, keyA } = await onA()
    const before = h.secrets.map.get(keyA)
    const exchanges = () =>
      a.calls.filter((c) => c.name === 'POST /auth/native/token').length
    const signIns = exchanges()
    const { held, call } = await heldRefresh(h, a)
    await h.client.call('auth.signIn', { origin: a.origin })
    held.release()
    await call
    // The refresh's rotated tokens were kept, and no new browser sign-in was needed.
    const after = h.secrets.map.get(keyA)
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    expect(exchanges()).toBe(signIns)
  })
})

describe('direct client: sign-in, capabilities and conversations', () => {
  it('signs in, goes online and negotiates honest capabilities', async () => {
    const h = await harness()
    const state = h.store.getState()
    expect(state.link).toMatchObject({
      phase: 'online',
      auth: 'native-pkce',
      connectionEpoch: 1,
      server: {
        origin: h.fake.origin,
        hermesVersion: '0.22.5',
        authority: 'legacy-sidecar-v8',
        sessionAuthority: false,
      },
    })
    const caps = state.capabilities
    expect(caps['chat.stream']?.state).toBe('available')
    expect(caps['sessions.replay']?.state).toBe('limited')
    // SOUL.md waits for display.status to name the profile Hermes serves.
    await h.waitFor(
      () => h.store.getState().capabilities['soul.write']?.state === 'limited',
    )
    // Memory entries need the learning routes, which the read-only probe found.
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    expect(caps['connections.accounts']?.state).toBe('unsupported')
    expect(caps['presence.unified']?.state).toBe('unavailable')
    await h.waitFor(
      () => h.store.getState().capabilities['computer.control']?.state === 'available',
    )
  })

  it('lists stored sessions as conversations', async () => {
    const fake = await fakeHermes()
    fake.store.seedSession(fake.now(), 'Inventory (fixture)', [
      { role: 'user', text: 'How many batches? (fixture)' },
      { role: 'assistant', text: '42 batches (fixture).' },
    ])
    const h = await harness({ fake })
    const list = await h.client.call('conversations.list', {})
    expect(list.map((c) => [c.title, c.kind, c.status])).toEqual([
      ['Inventory (fixture)', 'side', 'unknown'],
    ])
    expect(Object.keys(h.store.getState().conversations)).toEqual([list[0]?.id])
  })

  it('creates a conversation, streams a reply and keeps the transcript in sync', async () => {
    const h = await harness()
    const c = await conversation(h)
    expect(c).toMatchObject({ kind: 'side', status: 'idle', session: { storedId: c.id } })
    const prompt = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'Plan the week',
    })
    expect(prompt).toMatchObject({ state: 'accepted', disposition: 'streaming' })
    await h.waitFor(
      () => assistantText(h, c.id) === 'Synthetic reply (fixture) to: Plan the week',
    )
    const history = await h.client.call('conversations.history', { conversationId: c.id })
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(
      h.events.some(
        (e) =>
          e.type === 'history.loaded' &&
          e.conversationId === c.id &&
          e.messages.length === 2,
      ),
    ).toBe(true)
  })

  it('renames through the fenced REST write, or the live session before the first prompt', async () => {
    const h = await harness()
    const fresh = await conversation(h)
    await h.client.call('conversations.rename', {
      conversationId: fresh.id,
      title: 'Renamed early',
    })
    expect(h.rpcCalls('session.title')).toBe(1)
    await h.client.call('prompt.submit', {
      conversationId: fresh.id,
      clientId: 'p1',
      text: 'hello',
    })
    const stored = await h.waitFor(() => h.fake.store.sessions.get(fresh.id))
    const before = stored.revision
    const renamed = await h.client.call('conversations.rename', {
      conversationId: fresh.id,
      title: 'Weekly plan',
    })
    expect(renamed.title).toBe('Weekly plan')
    expect(stored.title).toBe('Weekly plan')
    expect(stored.revision).toBe(before + 1)
    expect(
      h.fake.calls.filter((c) => c.name === 'PATCH /api/sessions/' + fresh.id),
    ).toHaveLength(1)
  })

  it('pins the main conversation on this device only', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    const b = await conversation(h, 'B')
    await h.client.call('conversations.setMain', { conversationId: a.id })
    await h.client.call('conversations.setMain', { conversationId: b.id })
    const conversations = h.store.getState().conversations
    expect(entry(conversations, a.id)?.kind).toBe('side')
    expect(entry(conversations, b.id)?.kind).toBe('main')
    expect([...h.kv.map.values()]).toContain(JSON.stringify(b.id))
  })

  it('goes offline on stop() and reconnects on start() (review M5)', async () => {
    const h = await harness()
    h.client.stop()
    expect(h.store.getState().link.phase).toBe('offline')
    expect(h.store.getState().capabilities['chat.stream']?.state).toBe('unavailable')
    await h.client.start()
    await online(h, 2)
    expect(
      h.fake.calls.filter((call) => call.name === 'POST /api/auth/ws-ticket'),
    ).toHaveLength(2)
  })
})

describe('direct client: approvals and questions', () => {
  it('answers an approval once with an offered choice; answered means sent', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    expect(request).toMatchObject({
      kind: 'approval',
      conversationId: c.id,
      choices: ['once', 'deny'],
      withheldChoices: ['session', 'always'],
      status: 'open',
    })
    expect(request.requestId).toMatch(/^srq-[0-9a-f]{12}$/)
    expect(entry(h.store.getState().conversations, c.id)?.status).toBe('waiting-on-you')
    const answered = await approve(h, request.requestId, 'once')
    expect(answered.status).toBe('answered')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
    expect(await codeOf(approve(h, request.requestId, 'deny'))).toBe('not-found')
    expect(requestOf(h, request.requestId)?.status).toBe('answered')
    expect(h.fake.gateway.droppedResponses).toEqual([])
  })

  it('refuses a choice Hermes did not offer without sending anything', async () => {
    const h = await harness()
    approvalScript(h, ['deny'])
    const { request } = await openRequest(h)
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('invalid')
    expect(h.fake.gateway.open.has(request.requestId)).toBe(true)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
  })

  it('reports an answer it could not send and keeps the request answerable', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { request } = await openRequest(h)
    h.breakSends(true)
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('offline')
    expect(
      h.events.some(
        (e) => e.type === 'request.answer-failed' && e.requestId === request.requestId,
      ),
    ).toBe(true)
    expect(requestOf(h, request.requestId)).toMatchObject({ status: 'open' })
    expect(requestOf(h, request.requestId)?.answer).toBeUndefined()
    h.breakSends(false)
    await approve(h, request.requestId, 'once')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
  })

  it('closes a request Hermes withdrew and refuses to answer it afterwards', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    h.fake.gateway.expireRequest(request.requestId)
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'expired')
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('not-found')
  })

  it('shows an approval resolved from another surface as resolved elsewhere', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    h.fake.gateway.resolveElsewhere(request.requestId, 'deny')
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
  })

  it('notices, while the card is open, that another client answered it', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    const other = await connectRawClient(fake, fake.signIn())
    await other.request('session.resume', { session_id: c.id })
    other.send({ id: request.requestId, result: { choice: 'deny' } })
    await h.waitFor(() => outcome.done)
    // The sidecar tells this client nothing (server_requests.py:281-317); the
    // periodic check of open_requests closes the card.
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
    other.close()
  })

  it('keeps a request that is newer than the open-request list it is missing from', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    approvalScript(h)
    const { c, request } = await openRequest(h)
    let raised: Promise<unknown> | undefined
    // Hermes raises a request after building the list and before writing it.
    fake.gateway.afterHandle = (method) => {
      if (method !== 'session.events.since' || raised) return
      raised = fake.gateway.serverRequest(c.session.runtimeId ?? '', 'approval', {
        request_id: 'd'.repeat(32),
        command: 'ls (fixture)',
      })
    }
    const newer = await h.waitFor(() =>
      selectOpenRequests(h.store.getState()).find(
        (r) => r.requestId !== request.requestId,
      ),
    )
    await pause(150)
    expect(requestOf(h, newer.requestId)?.status).toBe('open')
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    await approve(h, newer.requestId, 'deny')
    await expect(raised).resolves.toEqual({ choice: 'deny' })
  })

  it('maps an interrupt to cancelled approvals', async () => {
    const h = await harness()
    approvalScript(h)
    const { c, request } = await openRequest(h)
    await h.client.call('conversation.interrupt', { conversationId: c.id })
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'cancelled')
  })

  it('answers the open questions of a clarify set and never overrides a lock', async () => {
    const h = await harness()
    const outcome: { result?: unknown } = {}
    h.fake.gateway.script = async (turn) => {
      outcome.result = await turn.clarify([
        {
          qid: 'q0',
          question: 'Venue? (fixture)',
          choices: ['North', 'South'],
          multi_select: false,
        },
        {
          qid: 'q1',
          question: 'Days? (fixture)',
          choices: ['Mon', 'Tue'],
          multi_select: true,
        },
      ])
    }
    const { request } = await openRequest(h)
    expect(request.questions?.map((q) => [q.qid, q.multiSelect])).toEqual([
      ['q0', false],
      ['q1', true],
    ])
    const clarify = (answers: Record<string, { choices: string[] }>) =>
      h.client.call('request.answer', {
        requestId: request.requestId,
        answer: { kind: 'clarify', answers },
      })
    // One reply settles the whole set, so it must cover every open question.
    expect(await codeOf(clarify({ q0: { choices: ['North'] } }))).toBe('invalid')
    // Another client locks q0; this client sees the lock after a reconnect.
    h.fake.gateway.lockClarify(request.requestId, 'q0', 'South')
    h.fake.gateway.dropConnections()
    await online(h, 2)
    const relisted = await h.waitFor(() => requestOf(h, request.requestId)?.lockedAnswers)
    expect(relisted).toEqual({ q0: { choices: ['South'] } })
    expect(
      await codeOf(clarify({ q0: { choices: ['North'] }, q1: { choices: ['Mon'] } })),
    ).toBe('invalid')
    await clarify({ q1: { choices: ['Mon', 'Tue'] } })
    await h.waitFor(() => outcome.result)
    expect(outcome.result).toEqual({
      answers: { q0: 'South', q1: '["Mon","Tue"]' },
      outcome: 'submitted',
    })
  })

  it('shows a credential prompt read-only, never answers it, and closes it with Hermes', async () => {
    const h = await harness()
    const c = await conversation(h)
    void h.fake.gateway.serverRequest(c.session.runtimeId ?? '', 'sudo', {
      command: 'apt list (fixture)',
    })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({
      kind: 'unsupported',
      unsupportedKind: 'sudo',
      conversationId: c.id,
      status: 'open',
      title: 'Hermes is asking for a sudo password',
      choices: [],
    })
    // Nothing from Hermes's params is shown, the command included.
    expect(request.command).toBeUndefined()
    expect(entry(h.store.getState().conversations, c.id)?.status).toBe('waiting-on-you')
    expect(await codeOf(approve(h, request.requestId, 'deny'))).toBe('unsupported')
    // Nothing was sent: it stays open for the terminal or the desktop app.
    expect(h.rpcCalls('request.answer')).toBe(0)
    expect([...h.fake.gateway.open.values()].map((r) => r.method)).toEqual(['sudo'])
    expect(h.fake.gateway.settled).toEqual([])
    expect(h.store.getState().notices).toEqual([])
    h.fake.gateway.expireRequest(request.requestId)
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'expired')
  })

  it('closes an unsupported request once another surface answered it', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    const c = await conversation(h)
    const pending = fake.gateway.serverRequest(
      c.session.runtimeId ?? '',
      'setup_beat',
      {},
    )
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'other' })
    const other = await connectRawClient(fake, fake.signIn())
    other.send({ id: request.requestId, result: { value: 'next (fixture)' } })
    await expect(pending).resolves.toEqual({ value: 'next (fixture)' })
    // The sidecar tells this client nothing; the open-requests check closes it.
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
    other.close()
  })

  it('reopens an unsupported request Hermes re-lists after a reconnect', async () => {
    const h = await harness()
    const c = await conversation(h)
    void h.fake.gateway.serverRequest(c.session.runtimeId ?? '', 'secret', {})
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ unsupportedKind: 'secret', lastSeenEpoch: 1 })
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() => requestOf(h, request.requestId)?.lastSeenEpoch === 2)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === c.id &&
          e.openRequestIds.includes(request.requestId),
      ),
    ).toBe(true)
    expect(h.fake.gateway.settled).toEqual([])
  })

  it('closes the requests of a session Hermes reclaimed', async () => {
    const h = await harness()
    approvalScript(h)
    const { c, request } = await openRequest(h)
    h.fake.gateway.broadcast('session.reclaimed', {
      session_id: c.session.runtimeId ?? '',
      stored_session_id: c.id,
      reason: 'idle_timeout',
    })
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'cancelled')
    expect(
      entry(h.store.getState().conversations, c.id)?.session.runtimeId,
    ).toBeUndefined()
  })

  it('keeps an app-level prompt open across a reconnect while Hermes still lists it', async () => {
    const h = await harness()
    // display.install.sudo goes to the client that clicked Install, with no session
    // (tui_gateway/methods_display.py:202-206); Hermes registers it for every list.
    const [mine] = [...h.fake.gateway.connections]
    void h.fake.gateway.appRequest(
      'display.install.sudo',
      { profile_key: 'default' },
      mine,
    )
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({
      kind: 'unsupported',
      unsupportedKind: 'sudo',
      status: 'open',
      lastSeenEpoch: 1,
    })
    expect(request.conversationId).toBeUndefined()
    expect(h.store.getState().notices).toEqual([])
    expect(await codeOf(approve(h, request.requestId, 'deny'))).toBe('unsupported')
    expect(h.rpcCalls('request.answer')).toBe(0)
    // A disconnect cancels nothing app-level: the new connection lists it again.
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() =>
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === undefined &&
          e.connectionEpoch === 2 &&
          e.openRequestIds.includes(request.requestId),
      ),
    )
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(h.fake.gateway.settled).toEqual([])
  })

  it('shows app-level prompts another surface started and closes the ones Hermes stops listing', async () => {
    const fake = await fakeHermes()
    // Started elsewhere: no connection here gets the frame, only the list has it.
    void fake.gateway.appRequest('display.install.sudo', { profile_key: 'default' })
    const h = await harness({ fake, deps: { connection: { requestSyncMs: 40 } } })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'sudo' })
    expect(request.conversationId).toBeUndefined()
    // Hermes's own deadline ends it; the periodic list no longer holds it.
    fake.gateway.expireRequest(request.requestId)
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
    // Nothing was ever sent for it.
    expect(h.rpcCalls('request.answer')).toBe(0)
  })

  it('shows an app-level prompt another surface starts while connected, without a reconnect', async () => {
    const h = await harness({ deps: { connection: { requestSyncMs: 40 } } })
    await h.waitFor(() =>
      h.events.some(
        (e) => e.type === 'requests.synced' && e.conversationId === undefined,
      ),
    )
    expect(selectOpenRequests(h.store.getState())).toEqual([])
    // Started elsewhere after this client connected: its frame goes only there.
    void h.fake.gateway.appRequest('display.install.sudo', { profile_key: 'default' })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'sudo' })
    expect(h.store.getState().link.connectionEpoch).toBe(1)
  })

  it('keeps an app-level prompt whose frame arrived after the list call was sent (N4)', async () => {
    const h = await harness()
    let raised = false
    // Hermes registers a new app-level prompt after building the list and before sending it.
    h.fake.gateway.afterHandle = (method, params) => {
      if (method !== 'session.events.since' || params.session_id !== '' || raised) return
      if (h.store.getState().link.connectionEpoch < 1) return
      raised = true
      const newest = [...h.fake.gateway.connections].at(-1)
      void h.fake.gateway.appRequest(
        'display.install.sudo',
        { profile_key: 'default' },
        newest,
      )
    }
    h.fake.gateway.dropConnections()
    await online(h, 2)
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    await h.waitFor(() =>
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === undefined &&
          e.connectionEpoch === 2 &&
          e.openRequestIds.includes(request.requestId),
      ),
    )
    expect(requestOf(h, request.requestId)?.status).toBe('open')
  })

  it('changes nothing app-level when the list cannot be read', async () => {
    const h = await harness()
    const [mine] = [...h.fake.gateway.connections]
    void h.fake.gateway.appRequest(
      'display.install.sudo',
      { profile_key: 'default' },
      mine,
    )
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    h.fake.gateway.respondError = (method, params) =>
      method === 'session.events.since' && params.session_id === ''
        ? { code: 5000, message: 'list failed (fixture)' }
        : undefined
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await pause(60)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(
      h.events.some(
        (e) =>
          e.type === 'requests.synced' &&
          e.conversationId === undefined &&
          e.connectionEpoch === 2,
      ),
    ).toBe(false)
  })

  it('skips a whole clarify set by skipping every open question', async () => {
    const h = await harness()
    const outcome: { result?: unknown } = {}
    h.fake.gateway.script = async (turn) => {
      outcome.result = await turn.clarify([
        { qid: 'q0', question: 'Venue? (fixture)', choices: ['North', 'South'] },
        { qid: 'q1', question: 'Anything else? (fixture)' },
      ])
    }
    const { request } = await openRequest(h)
    await h.client.call('request.answer', {
      requestId: request.requestId,
      answer: {
        kind: 'clarify',
        answers: { q0: { skipped: true }, q1: { skipped: true } },
      },
    })
    await h.waitFor(() => outcome.result)
    // Each question reaches the agent as skipped, with outcome submitted, never cancelled.
    expect(outcome.result).toEqual({
      answers: { q0: null, q1: null },
      outcome: 'submitted',
    })
  })

  it('answers through request.answer and stays answering until Hermes acknowledges', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { request } = await openRequest(h)
    let release: () => void = () => undefined
    h.fake.gateway.beforeHandle = (method) =>
      method === 'request.answer'
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : undefined
    const answered = approve(h, request.requestId, 'once')
    await h.waitFor(() => h.rpcCalls('request.answer') === 1)
    expect(requestOf(h, request.requestId)?.status).toBe('answering')
    expect(h.events.some((e) => e.type === 'request.closed')).toBe(false)
    release()
    await expect(answered).resolves.toMatchObject({ status: 'answered' })
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
    // Settled by the acknowledged call, never by a bare response frame.
    expect(h.fake.gateway.settled).toEqual([
      expect.objectContaining({ id: request.requestId, outcome: 'answered' }),
    ])
    expect(h.fake.gateway.settled[0]?.by).toBeUndefined()
  })

  it('reports a request Hermes no longer waited for as resolved elsewhere', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    // Another client answered it with a bare frame: the sidecar tells this client nothing.
    const open = h.fake.gateway.open.get(request.requestId)
    h.fake.gateway.open.delete(request.requestId)
    open?.settle({ choice: 'deny' })
    const result = await h.client.call('request.answer', {
      requestId: request.requestId,
      answer: { kind: 'approval', choice: 'once' },
    })
    expect(result.status).toBe('resolved-elsewhere')
    const closing = h.events.filter(
      (e) =>
        (e.type === 'request.closed' || e.type === 'request.answer-failed') &&
        e.requestId === request.requestId,
    )
    expect(closing).toEqual([
      {
        type: 'request.closed',
        requestId: request.requestId,
        status: 'resolved-elsewhere',
        connectionEpoch: 1,
      },
    ])
    // The answer this client sent is kept for display (contract v4).
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'resolved-elsewhere',
      answer: { kind: 'approval', choice: 'once' },
    })
  })

  it('shows a request that arrives before the reply binding its session', async () => {
    const fake = await fakeHermes()
    const other = await connectRawClient(fake, fake.signIn())
    const created = (await other.request('session.create', {})) as {
      result: { session_id: string; stored_session_id: string }
    }
    const { session_id: sid, stored_session_id: storedId } = created.result
    await other.request('prompt.submit', { session_id: sid, text: 'hello (fixture)' })
    const h = await harness({ fake })
    await h.waitFor(() => fake.store.sessions.get(storedId)?.rows.length === 2)
    await h.client.call('conversations.list', {})
    let raised: Promise<unknown> | undefined
    // Hermes attaches this socket, then asks before it writes the resume reply.
    fake.gateway.afterHandle = (method) => {
      if (method !== 'session.resume' || raised) return
      raised = fake.gateway.serverRequest(sid, 'approval', {
        request_id: 'e'.repeat(32),
        command: 'ls (fixture)',
      })
    }
    await h.client.call('conversations.history', { conversationId: storedId })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request.conversationId).toBe(storedId)
    await approve(h, request.requestId, 'deny')
    await expect(raised).resolves.toEqual({ choice: 'deny' })
    other.close()
  })
})

describe('direct client: reconnect and replay', () => {
  it('reconnects with a fresh ticket, re-attaches and replays what it missed', async () => {
    const h = await harness()
    const c = await conversation(h)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.fake.gateway.script = async (turn) => {
      turn.emit('message.start', {})
      turn.emit('message.delta', { text: 'before the drop, ' })
      await gate
      turn.emit('message.delta', { text: 'while away, ' })
      turn.emit('message.delta', { text: 'and after.' })
      turn.emit('message.complete', {
        text: 'before the drop, while away, and after.',
        status: 'complete',
      })
    }
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'go',
    })
    await h.waitFor(() => assistantText(h, c.id) === 'before the drop, ')
    h.fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    release()
    await online(h, 2)
    await h.waitFor(
      () => assistantText(h, c.id) === 'before the drop, while away, and after.',
    )
    const deltas = h.events
      .filter((e) => e.type === 'message.delta')
      .map((e) => (e.type === 'message.delta' ? e.text : ''))
    expect(deltas).toEqual(['before the drop, ', 'while away, ', 'and after.'])
    expect(
      h.fake.calls.filter((call) => call.name === 'POST /api/auth/ws-ticket'),
    ).toHaveLength(2)
    // The replay and the app-level list share session.events.since.
    expect(h.rpcCalls('session.events.since')).toBeGreaterThanOrEqual(2)
    expect(
      h.events.some((e) => e.type === 'requests.synced' && e.conversationId === c.id),
    ).toBe(true)
  })

  it('reloads history instead of trusting replay after a Hermes restart', async () => {
    const h = await harness()
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'hi',
    })
    await h.waitFor(() => assistantText(h, c.id).startsWith('Synthetic reply'))
    await h.client.call('conversations.history', { conversationId: c.id })
    h.fake.gateway.restart()
    await h.waitFor(() =>
      h.events.some(
        (e) =>
          e.type === 'history.reset' &&
          e.conversationId === c.id &&
          e.reason === 'epoch-changed',
      ),
    )
    expect(entry(h.store.getState().messages, c.id)).toBeUndefined()
    await online(h)
    const reloaded = await h.client.call('conversations.history', {
      conversationId: c.id,
    })
    expect(reloaded.messages).toHaveLength(2)
  })

  it('reloads history when the replay window was truncated', async () => {
    const h = await harness()
    h.fake.gateway.ringMax = 2
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'hi',
    })
    await h.waitFor(() => assistantText(h, c.id).startsWith('Synthetic reply'))
    await h.client.call('conversations.history', { conversationId: c.id })
    h.fake.gateway.frozen = true
    const sid = c.session.runtimeId ?? ''
    for (let i = 0; i < 5; i++)
      h.fake.gateway.emit(sid, 'status.update', { kind: 'status', text: `step ${i}` })
    h.fake.gateway.frozen = false
    h.fake.gateway.dropConnections()
    await h.waitFor(() =>
      h.events.some((e) => e.type === 'history.reset' && e.reason === 'truncated'),
    )
  })

  it('offers a request raised while it was disconnected once it is back', async () => {
    const h = await harness()
    const c = await conversation(h)
    h.fake.gateway.dropConnections()
    // No client attached: Hermes keeps it for the next one (session_transports.py:58-67).
    const pending = h.fake.gateway.serverRequest(c.session.runtimeId ?? '', 'approval', {
      request_id: 'a'.repeat(32),
      command: 'ls (fixture)',
    })
    await online(h, 2)
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    await approve(h, request.requestId, 'deny')
    await expect(pending).resolves.toEqual({ choice: 'deny' })
  })

  it('closes requests another client answered while it was away', async () => {
    const h = await harness()
    h.fake.gateway.script = async (turn) => {
      await turn.approval()
    }
    const { request } = await openRequest(h)
    const open = h.fake.gateway.open.get(request.requestId)
    // Another client's reply settles it while Cindl's socket is down.
    h.fake.gateway.dropConnections()
    h.fake.gateway.open.delete(request.requestId)
    open?.settle({ choice: 'deny' })
    await online(h, 2)
    await h.waitFor(
      () => requestOf(h, request.requestId)?.status === 'resolved-elsewhere',
    )
  })

  it('reopens a request whose answer never reached Hermes', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { request } = await openRequest(h)
    // A silently dead socket: the answer is written but Hermes never reads it.
    h.fake.gateway.frozen = true
    const lost = approve(h, request.requestId, 'deny')
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'answering')
    await pause(30)
    h.fake.gateway.frozen = false
    expect(h.fake.gateway.open.has(request.requestId)).toBe(true)
    h.fake.gateway.dropConnections()
    // No acknowledgement: the call fails and the request is answerable again.
    expect(await codeOf(lost)).toBe('offline')
    expect(
      h.events.filter(
        (e) => e.type === 'request.answer-failed' && e.requestId === request.requestId,
      ),
    ).toHaveLength(1)
    await online(h, 2)
    // Hermes still lists it after the reconnect, so that answer did not land.
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'open')
    expect(outcome.done).toBeUndefined()
    await approve(h, request.requestId, 'once')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
  })

  it('keeps a live request that arrives while another session re-attaches (review H1)', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    const b = await conversation(h, 'B')
    let resumes = 0
    let raised: Promise<unknown> | undefined
    h.fake.gateway.beforeHandle = async (method) => {
      if (method !== 'session.resume' || ++resumes !== 2) return
      // One session is already back on the new socket when it asks for approval.
      raised = h.fake.gateway.serverRequest(a.session.runtimeId ?? '', 'approval', {
        request_id: 'c'.repeat(32),
        command: 'ls (fixture)',
      })
      await pause(50)
    }
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() => resumes >= 2)
    const request = await h.waitFor(() =>
      selectOpenRequests(h.store.getState()).find((r) => r.conversationId === a.id),
    )
    await pause(60)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    expect(h.fake.gateway.live.get(b.session.runtimeId ?? '')?.connections.size).toBe(1)
    await approve(h, request.requestId, 'deny')
    await expect(raised).resolves.toEqual({ choice: 'deny' })
  })

  it('keeps every session and its requests when the socket drops while re-attaching (review H2)', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    const outcome = approvalScript(h)
    const { c: b, request } = await openRequest(h, await conversation(h, 'B'))
    let dropped = false
    h.fake.gateway.beforeHandle = (method) => {
      if (method !== 'session.resume' || dropped) return
      dropped = true
      h.fake.gateway.dropConnections()
    }
    h.fake.gateway.dropConnections()
    await online(h, 3)
    await h.waitFor(
      () => h.fake.gateway.live.get(b.session.runtimeId ?? '')?.connections.size === 1,
    )
    expect(h.fake.gateway.live.get(a.session.runtimeId ?? '')?.connections.size).toBe(1)
    expect(requestOf(h, request.requestId)?.status).toBe('open')
    await approve(h, request.requestId, 'once')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
  })

  it('closes a request with the reason Hermes gave while it was re-attaching (review M2)', async () => {
    const h = await harness()
    approvalScript(h)
    const { request } = await openRequest(h)
    h.fake.gateway.beforeHandle = (method) => {
      if (method === 'session.events.since')
        h.fake.gateway.expireRequest(request.requestId)
    }
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'expired')
    await pause(30)
    expect(requestOf(h, request.requestId)?.status).toBe('expired')
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('not-found')
  })
})

type Row = Array<string | number | boolean | null>

/** One request's lifecycle as compact rows, plus its conversation's syncs, in order. */
function lifecycle(h: Harness, requestId: string, conversationId: string): Row[] {
  const choice = (answer: unknown) =>
    (answer as { choice?: string } | undefined)?.choice ?? null
  return h.events.flatMap((e: CindlEvent): Row[] => {
    if (e.type === 'request.opened' && e.request.requestId === requestId)
      return [
        ['opened', e.request.status, e.request.lastSeenEpoch, choice(e.request.answer)],
      ]
    if (e.type === 'request.closed' && e.requestId === requestId)
      return [['closed', e.status, e.connectionEpoch ?? null, choice(e.answer)]]
    if (e.type === 'request.answer-failed' && e.requestId === requestId)
      return [['failed', e.connectionEpoch ?? null]]
    if (e.type === 'requests.synced' && e.conversationId === conversationId)
      return [['synced', e.openRequestIds.includes(requestId)]]
    return []
  })
}

describe('direct client: answer identity across reconnects', () => {
  it('ties each answer outcome to the connection it was sent on (drop mid-answer, answer again)', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    // The first answer is written to a silently dead socket: Hermes never reads it.
    h.fake.gateway.frozen = true
    const first = approve(h, request.requestId, 'deny')
    await h.waitFor(() => requestOf(h, request.requestId)?.status === 'answering')
    h.fake.gateway.frozen = false
    h.fake.gateway.dropConnections()
    expect(await codeOf(first)).toBe('offline')
    // Reconnect: Hermes still holds the request and re-lists it on the new connection.
    await online(h, 2)
    await h.waitFor(() => requestOf(h, request.requestId)?.lastSeenEpoch === 2)
    const second = await approve(h, request.requestId, 'once')
    expect(second.status).toBe('answered')
    await h.waitFor(() => outcome.done)
    expect(outcome.result).toEqual({ choice: 'once' })
    expect(lifecycle(h, request.requestId, c.id)).toEqual([
      ['opened', 'open', 1, null],
      ['opened', 'answering', 1, 'deny'],
      ['failed', 1],
      ['opened', 'open', 2, null],
      ['synced', true],
      ['opened', 'answering', 2, 'once'],
      ['closed', 'answered', 2, 'once'],
    ])
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'answered',
      lastSeenEpoch: 2,
      answer: { kind: 'approval', choice: 'once' },
    })
    expect(h.fake.gateway.settled).toEqual([
      expect.objectContaining({
        id: request.requestId,
        outcome: 'answered',
        result: { choice: 'once' },
      }),
    ])
  })

  it('keeps one answer when a history load re-lists the request while the answer is in flight', async () => {
    const h = await harness()
    const outcome = approvalScript(h)
    const { c, request } = await openRequest(h)
    // Upstream session.resume runs in the worker pool (tui_gateway/server.py:180-199), so
    // its open-request snapshot can be older than an answer Hermes handles meanwhile.
    let release: () => void = () => undefined
    h.fake.gateway.beforeHandle = (method) =>
      method === 'request.answer'
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : undefined
    const answered = approve(h, request.requestId, 'deny')
    await h.waitFor(() => h.rpcCalls('request.answer') === 1)
    await h.client.call('conversations.history', { conversationId: c.id })
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'answering',
      answer: { kind: 'approval', choice: 'deny' },
    })
    release()
    await expect(answered).resolves.toMatchObject({ status: 'answered' })
    await h.waitFor(() => outcome.done)
    expect(lifecycle(h, request.requestId, c.id)).toEqual([
      ['opened', 'open', 1, null],
      ['opened', 'answering', 1, 'deny'],
      ['opened', 'open', 1, null],
      ['synced', true],
      ['closed', 'answered', 1, 'deny'],
    ])
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'answered',
      answer: { kind: 'approval', choice: 'deny' },
    })
    // The re-listed copy is not answerable again: nothing more is sent.
    expect(await codeOf(approve(h, request.requestId, 'once'))).toBe('not-found')
    expect(h.rpcCalls('request.answer')).toBe(1)
  })

  it('reconnects instead of going online when a re-attach stalls on a live socket', async () => {
    // A re-attach that times out on a socket that is still up used to end
    // reconciliation early and still go online, leaving later conversations
    // unattached (their requests kept an older epoch and their events went nowhere).
    const h = await harness({ deps: { connection: { requestTimeoutMs: 300 } } })
    const a = await conversation(h, 'A')
    approvalScript(h)
    const { c: b, request } = await openRequest(h, await conversation(h, 'B'))
    h.fake.gateway.failNext.set('session.resume', 'no-response')
    h.fake.gateway.dropConnections()
    await online(h, 3)
    expect(h.store.getState().link.connectionEpoch).toBe(3)
    // Every conversation is attached to the socket that went online.
    for (const c of [a, b])
      expect(h.fake.gateway.live.get(c.session.runtimeId ?? '')?.connections.size).toBe(1)
    expect(requestOf(h, request.requestId)).toMatchObject({
      status: 'open',
      lastSeenEpoch: 3,
    })
    await approve(h, request.requestId, 'once')
    expect(lifecycle(h, request.requestId, b.id).slice(-2)).toEqual([
      ['opened', 'answering', 3, 'once'],
      ['closed', 'answered', 3, 'once'],
    ])
  })

  it('skips a session whose resume fails and re-attaches the others', async () => {
    const h = await harness()
    const a = await conversation(h, 'A')
    approvalScript(h)
    const { c: b, request: bad } = await openRequest(h, await conversation(h, 'B'))
    const { c, request: good } = await openRequest(h, await conversation(h, 'C'))
    // Hermes answers B's resume with an error every time.
    h.fake.gateway.respondError = (method, params) =>
      method === 'session.resume' && params.session_id === b.id
        ? { code: 5000, message: 'resume failed (fixture)' }
        : undefined
    h.fake.gateway.dropConnections()
    await online(h, 2)
    expect(h.store.getState().link.connectionEpoch).toBe(2)
    // B counts as gone here: detached, its request closed on this client.
    expect(
      entry(h.store.getState().conversations, b.id)?.session.runtimeId,
    ).toBeUndefined()
    expect(requestOf(h, bad.requestId)?.status).toBe('resolved-elsewhere')
    // The loop went on: A and C are attached and C's request is re-listed.
    for (const conv of [a, c])
      expect(
        h.fake.gateway.live.get(conv.session.runtimeId ?? '')?.connections.size,
      ).toBe(1)
    expect(requestOf(h, good.requestId)).toMatchObject({
      status: 'open',
      lastSeenEpoch: 2,
    })
  })
})

describe('direct client: prompts', () => {
  it('marks a prompt uncertain when the reply is lost and never sends it again', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    fake.gateway.failNext.set('prompt.submit', 'drop-before-response')
    const prompt = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-lost',
      text: 'charge the card',
    })
    expect(prompt.state).toBe('uncertain')
    await online(h, 2)
    await pause(50)
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    // The same client id is never sent again, even if the UI retries.
    const retried = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-lost',
      text: 'charge the card',
    })
    expect(retried.state).toBe('uncertain')
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    // A restarted app recovers it as uncertain and still does not send it.
    h.client.stop()
    const again = await harness({ fake, kv: h.kv, secrets: h.secrets })
    expect(entry(again.store.getState().prompts, 'p-lost')?.state).toBe('uncertain')
    expect(again.rpcCalls('prompt.submit')).toBe(1)
    await expect(
      again.client.call('prompt.discard', { clientId: 'p-lost' }),
    ).resolves.toEqual({ discarded: true })
    expect(
      again.events.some((e) => e.type === 'prompt.removed' && e.clientId === 'p-lost'),
    ).toBe(true)
    expect(entry(again.store.getState().prompts, 'p-lost')).toBeUndefined()
  })

  it('never sends an accepted client id again, even after a restart (review L5)', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-once',
      text: 'hello',
    })
    h.client.stop()
    const again = await harness({ fake, kv: h.kv, secrets: h.secrets })
    const retried = await again.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-once',
      text: 'hello',
    })
    expect(retried.state).toBe('accepted')
    expect(again.rpcCalls('prompt.submit')).toBe(1)
  })

  it('sends offline prompts behind a running turn instead of redirecting it (review M4)', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    const gates: Array<() => void> = []
    fake.gateway.script = async (turn) => {
      turn.emit('message.start', {})
      await new Promise<void>((resolve) => gates.push(resolve))
    }
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-run',
      text: 'long task',
    })
    await h.waitFor(() => gates.length === 1)
    fake.gateway.frozen = true
    fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    const queued = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-later',
      text: 'and then this',
    })
    expect(queued.state).toBe('queued-offline')
    fake.gateway.frozen = false
    await h.waitFor(
      () => entry(h.store.getState().prompts, 'p-later')?.state === 'accepted',
    )
    expect(entry(h.store.getState().prompts, 'p-later')?.disposition).toBe('queued')
    // Typed while online, the same message redirects the turn (Hermes's default).
    const typed = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-now',
      text: 'stop and do this',
    })
    expect(typed.disposition).toBe('redirected')
    for (const release of gates.splice(0)) release()
  })

  it('does not send a queued prompt discarded during the flush (review H3)', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    fake.gateway.frozen = true
    fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'one',
    })
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p2',
      text: 'two',
    })
    let discarded: Promise<unknown> | undefined
    fake.gateway.beforeHandle = async (method) => {
      if (method !== 'prompt.submit' || discarded) return
      discarded = h.client.call('prompt.discard', { clientId: 'p2' })
      await discarded
    }
    fake.gateway.frozen = false
    await h.waitFor(() => entry(h.store.getState().prompts, 'p1')?.state === 'accepted')
    await expect(discarded).resolves.toEqual({ discarded: true })
    await pause(50)
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    expect(entry(h.store.getState().prompts, 'p2')).toBeUndefined()
  })

  it('does not send a prompt it could not record as sending (review M1)', async () => {
    const base = memoryKv()
    const kv: KeyValueStore & { map: Map<string, string> } = {
      ...base,
      set: (key, value) =>
        value.includes('"state":"sending"')
          ? Promise.reject(new Error('disk full (fixture)'))
          : base.set(key, value),
    }
    const h = await harness({ kv })
    const c = await conversation(h)
    const prompt = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'hello',
    })
    expect(prompt.state).toBe('queued-offline')
    expect(prompt.error).toMatch(/could not record/)
    expect(h.rpcCalls('prompt.submit')).toBe(0)
  })
})

describe('direct client: owner edits, routines, connections, screen', () => {
  it('writes SOUL.md only when the reviewed version still matches', async () => {
    const h = await harness()
    await h.waitFor(() => h.store.getState().capabilities['soul.read'] !== undefined)
    const read = await h.client.call('soul.read', {})
    expect(read.version).toBe(sha256Hex(read.content))
    h.fake.store.profile('default').soul = 'Changed on the host (fixture)\n'
    expect(
      await codeOf(
        h.client.call('soul.write', {
          content: 'mine',
          expectedVersion: read.version,
          confirm: true,
        }),
      ),
    ).toBe('conflict')
    expect(h.fake.store.profile('default').soul).toBe('Changed on the host (fixture)\n')
    const fresh = await h.client.call('soul.read', {})
    const written = await h.client.call('soul.write', {
      content: 'Mine (fixture)\n',
      expectedVersion: fresh.version,
      confirm: true,
    })
    expect(written).toMatchObject({
      content: 'Mine (fixture)\n',
      version: sha256Hex('Mine (fixture)\n'),
    })
  })

  it('writes a skill only when the reviewed version still matches', async () => {
    const h = await harness()
    const skill = await h.client.call('skills.read', { name: 'fixture-notes' })
    const written = await h.client.call('skills.write', {
      name: 'fixture-notes',
      content: 'Notes v2 (fixture)\n',
      expectedVersion: skill.version,
      confirm: true,
    })
    expect(written).toMatchObject({
      content: 'Notes v2 (fixture)\n',
      version: sha256Hex('Notes v2 (fixture)\n'),
    })
    const onHost = h.fake.store.profile('default').skills.get('fixture-notes')
    if (onHost) onHost.content += 'edited elsewhere (fixture)\n'
    expect(
      await codeOf(
        h.client.call('skills.write', {
          name: 'fixture-notes',
          content: 'x',
          expectedVersion: written.version,
          confirm: true,
        }),
      ),
    ).toBe('conflict')
    expect(onHost?.content).toBe('Notes v2 (fixture)\nedited elsewhere (fixture)\n')
    const list = await h.client.call('skills.list', {})
    expect(list.map((s) => [s.name, s.enabled])).toEqual([
      ['fixture-notes', true],
      ['fixture-report', false],
    ])
  })

  it('lists routines including paused ones and pauses or resumes them through cron.manage', async () => {
    const h = await harness()
    const routines = await h.client.call('routines.list', {})
    expect(routines.map((r) => [r.id, r.enabled])).toEqual([
      ['fixture-job-1', true],
      ['fixture-job-2', false],
    ])
    const resumed = await h.client.call('routines.setEnabled', {
      id: 'fixture-job-2',
      enabled: true,
      confirm: true,
    })
    expect(resumed.enabled).toBe(true)
    expect(
      await codeOf(
        h.client.call('routines.setEnabled', {
          id: 'missing-job',
          enabled: false,
          confirm: true,
        }),
      ),
    ).toBe('not-found')
  })

  it('maps MCP health without transport details and refuses account coverage', async () => {
    const h = await harness()
    const servers = await h.client.call('connections.mcp', {})
    expect(servers.map((s) => [s.name, s.state, s.toolCount])).toEqual([
      ['fixture-notes', 'connected', 3],
      ['fixture-calendar', 'error', 0],
    ])
    expect(await codeOf(h.client.call('connections.accounts', {}))).toBe('unsupported')
    const memory = await h.client.call('memory.overview', {})
    expect(memory.items.map((i) => i.key)).toContain('builtin:memory')
    expect(h.fake.calls.some((c) => /connectors|\/api\/fs/.test(c.name))).toBe(false)
    // The only learning call is the read-only probe that establishes memory.text.
    expect(
      h.fake.calls.filter(
        (c) => /learning/.test(c.name) && c.name !== 'GET /api/learning/graph',
      ),
    ).toEqual([])
  })

  it('reports the agent screen and takes and returns control with its own viewer id', async () => {
    const h = await harness()
    expect(await h.client.call('display.status', {})).toMatchObject({
      status: 'running',
      controller: 'agent',
      leaseHeldByThisDevice: false,
    })
    const held = await h.client.call('display.acquireControl', { confirm: true })
    expect(held).toMatchObject({ controller: 'you', leaseHeldByThisDevice: true })
    expect(h.fake.store.display.holder).toBe('human')
    const returned = await h.client.call('display.releaseControl', {})
    expect(returned).toMatchObject({ controller: 'agent', leaseHeldByThisDevice: false })
    expect(h.fake.calls.some((c) => /display\.(start|stop|install)/.test(c.name))).toBe(
      false,
    )
  })
})

describe('direct client: the profile Hermes serves', () => {
  const soulKnown = (h: Harness) =>
    h.waitFor(() => h.store.getState().capabilities['soul.read'] !== undefined)

  it('edits the served profile, never `default`, under hermes -p <name> serve', async () => {
    const fake = await fakeHermes()
    const studio = fake.store.serveAs('studio')
    studio.soul = '# SOUL (fixture)\n\nStudio voice (fixture).\n'
    studio.memory.memory = ['Studio-only note (fixture).']
    const fallback = fake.store.profile('default')
    const defaultSoul = fallback.soul
    const defaultMemory = [...fallback.memory.memory]
    const h = await harness({ fake })
    await soulKnown(h)
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )

    const soul = await h.client.call('soul.read', {})
    expect(soul.content).toContain('Studio voice')
    await h.client.call('soul.write', {
      content: 'Studio, edited (fixture)\n',
      expectedVersion: soul.version,
      confirm: true,
    })
    expect(studio.soul).toBe('Studio, edited (fixture)\n')

    const entries = await h.client.call('memory.entries', {})
    expect(entries.map((e) => e.preview)).toEqual([
      'Studio-only note (fixture).',
      ...studio.memory.profile,
    ])
    const [first] = entries
    await h.client.call('memory.delete', { id: first?.id ?? '', confirm: true })
    expect(studio.memory.memory).toEqual([])
    // The default profile was never read or touched, and no request named a
    // profile Hermes does not serve (that loads its secrets upstream).
    expect(fallback.soul).toBe(defaultSoul)
    expect(fallback.memory.memory).toEqual(defaultMemory)
    expect(fake.store.otherProfileScopes).toEqual([])
  })

  it('reads, edits and sizes memory on the served profile when a clone shares its ids', async () => {
    const fake = await fakeHermes()
    // `hermes profile create --clone` copies MEMORY.md and USER.md, so both
    // profiles hold the same entries under the same fingerprinted ids and the
    // id alone cannot tell them apart.
    const fallback = fake.store.profile('default')
    const work = fake.store.serveAs('work')
    work.memory.memory = [...fallback.memory.memory]
    work.memory.profile = [...fallback.memory.profile]
    const untouched = [...fallback.memory.memory]
    const h = await harness({ fake })
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    await h.client.call('memory.overview', {})
    const [first] = await h.client.call('memory.entries', {})
    const id = first?.id ?? ''
    expect((await h.client.call('memory.read', { id })).content).toBe(
      work.memory.memory[0],
    )
    await h.client.call('memory.write', {
      id,
      content: 'Edited on the served profile (fixture).',
      confirm: true,
    })
    expect(work.memory.memory[0]).toBe('Edited on the served profile (fixture).')
    expect(fallback.memory.memory).toEqual(untouched)
    // No request, the read and the overview included, named another profile.
    expect(fake.store.otherProfileScopes).toEqual([])
  })

  it('refuses SOUL.md when Hermes serves a home no profile name addresses', async () => {
    const fake = await fakeHermes()
    fake.store.serveAs('custom')
    const h = await harness({ fake })
    await soulKnown(h)
    const capability = h.store.getState().capabilities['soul.write']
    expect(capability?.state).toBe('unavailable')
    expect(capability?.reason).toMatch(/no profile name addresses/)
    expect(await codeOf(h.client.call('soul.read', {}))).toBe('unavailable')
    expect(h.fake.calls.some((c) => /\/soul$/.test(c.name))).toBe(false)
  })

  it('uses a profile the platform pinned for SOUL.md and memory entries', async () => {
    const fake = await fakeHermes()
    const studio = fake.store.profile('studio')
    studio.memory.memory = ['Pinned-profile note (fixture).']
    const h = await harness({ fake, deps: { profile: 'studio' } })
    await soulKnown(h)
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    expect((await h.client.call('memory.entries', {}))[0]?.preview).toBe(
      'Pinned-profile note (fixture).',
    )
    expect((await h.client.call('soul.read', {})).content).toContain(
      'studio fixture agent',
    )
  })
})

describe('direct client: screen control across reconnects', () => {
  it("hands control back with the earlier viewer id, and never another viewer's lease", async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['computer.control']?.state === 'available',
    )
    await h.client.call('display.acquireControl', { confirm: true })
    h.fake.gateway.dropConnections()
    await online(h, 2)
    expect(h.store.getState().display?.controller).toBe('you')
    expect(await h.client.call('display.releaseControl', {})).toMatchObject({
      controller: 'agent',
      leaseHeldByThisDevice: false,
    })
    expect(h.fake.store.display.holder).toBe('agent')

    const other = await connectRawClient(h.fake, h.fake.signIn())
    const observed = (await other.request('display.observe', {})) as {
      result: { viewer_id: string }
    }
    await other.request('display.lease.acquire', { viewer_id: observed.result.viewer_id })
    await h.waitFor(() => h.store.getState().display?.controller === 'another-viewer')
    expect(await h.client.call('display.releaseControl', {})).toMatchObject({
      controller: 'another-viewer',
    })
    expect(h.fake.store.display.holderViewerId).toBe(observed.result.viewer_id)
    other.close()
  })
})

describe('direct client: memory entries', () => {
  const memoryCalls = (h: Harness) =>
    h.fake.calls
      .filter((c) => /learning|memory|\/api\/fs|files/i.test(c.name))
      .map((c) => c.name)

  it('keeps memory entries unknown after a transient probe failure and probes again', async () => {
    const fake = await fakeHermes()
    fake.failNextRest('GET /api/learning/graph', 503)
    const h = await harness({ fake })
    await h.waitFor(() => h.fake.calls.some((c) => c.name === 'GET /api/learning/graph'))
    // A 503 does not prove the routes are missing: unknown, not unsupported.
    await h.client.call('routines.list', {})
    expect(h.store.getState().capabilities['memory.text']).toBeUndefined()
    h.fake.gateway.dropConnections()
    await online(h, 2)
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
  })

  it('negotiates memory entries from the learning routes and never reads memory files', async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    expect(memoryCalls(h)).toEqual(['GET /api/learning/graph'])
    // A Hermes without the routes: unsupported, with no fallback of any kind.
    const bare = await harness({ fake: await fakeHermes({ learningRoutes: false }) })
    const missing = await bare.waitFor(
      () => bare.store.getState().capabilities['memory.text']?.state === 'unsupported',
    )
    expect(missing).toBe(true)
    expect(bare.store.getState().capabilities['memory.text']?.reason).toMatch(
      /does not expose single memory entries/,
    )
    expect(await codeOf(bare.client.call('memory.entries', {}))).toBe('unsupported')
    expect(memoryCalls(bare)).toEqual(['GET /api/learning/graph'])
  })

  it('lists, reads, edits and deletes entries by their fingerprinted ids', async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    const entries = await h.client.call('memory.entries', {})
    expect(entries.map((e) => e.store)).toEqual(['memory', 'memory', 'profile'])
    for (const e of entries)
      expect(e.id).toMatch(/^memory:(memory|profile):\d+:[a-f0-9]{12}$/)
    const [first] = entries
    if (!first) throw new Error('no entries')
    const read = await h.client.call('memory.read', { id: first.id })
    expect(read).toMatchObject({ id: first.id, store: 'memory', content: first.preview })
    // The id is the version: an edit returns the entry under its new id.
    const written = await h.client.call('memory.write', {
      id: first.id,
      content: 'Studio calendar moved to Thursdays (fixture).',
      confirm: true,
    })
    expect(written.id).not.toBe(first.id)
    expect(written).toMatchObject({
      store: 'memory',
      content: 'Studio calendar moved to Thursdays (fixture).',
    })
    expect(h.fake.store.profile('default').memory.memory[0]).toBe(
      'Studio calendar moved to Thursdays (fixture).',
    )
    await expect(
      h.client.call('memory.delete', { id: written.id, confirm: true }),
    ).resolves.toEqual({ deleted: true })
    const after = await h.client.call('memory.entries', {})
    expect(after.map((e) => e.id)).not.toContain(written.id)
    expect(after).toHaveLength(2)
  })

  it('refuses stale ids, text over the store limit, positional ids and unconfirmed changes', async () => {
    const h = await harness()
    await h.waitFor(
      () => h.store.getState().capabilities['memory.text']?.state === 'available',
    )
    const [entry] = await h.client.call('memory.entries', {})
    if (!entry) throw new Error('no entries')
    const writes = () =>
      h.fake.calls.filter((c) => c.name === 'PUT /api/learning/node').length
    // Changed on the host after it was listed: Hermes refuses the old id.
    h.fake.store.profile('default').memory.memory[0] = 'Changed by the agent (fixture).'
    expect(
      await codeOf(
        h.client.call('memory.write', {
          id: entry.id,
          content: 'Mine (fixture).',
          confirm: true,
        }),
      ),
    ).toBe('conflict')
    expect(h.fake.store.profile('default').memory.memory[0]).toBe(
      'Changed by the agent (fixture).',
    )
    const [fresh] = await h.client.call('memory.entries', {})
    if (!fresh) throw new Error('no entries')
    // Longer than the agent-notes limit (2,200 by default).
    expect(
      await codeOf(
        h.client.call('memory.write', {
          id: fresh.id,
          content: 'x'.repeat(2_300),
          confirm: true,
        }),
      ),
    ).toBe('invalid')
    const sent = writes()
    // Refused before anything is sent: a positional id and a missing confirmation.
    const positional = await h.client
      .call('memory.read', { id: 'memory:memory:0' })
      .catch((e: unknown) => e as CindlError)
    expect(positional).toMatchObject({ code: 'invalid' })
    expect((positional as CindlError).message).toMatch(/^Not sent:/)
    expect(
      await codeOf(
        h.client.call('memory.write', {
          id: fresh.id,
          content: 'Unconfirmed (fixture).',
        } as unknown as { id: string; content: string; confirm: true }),
      ),
    ).toBe('invalid')
    expect(writes()).toBe(sent)
  })
})

describe('direct client: refusals', () => {
  it('reports loopback-token Hermes as incompatible and never reads its token', async () => {
    const fake = await fakeHermes({ mode: 'loopback' })
    const h = await harness({ fake, signIn: false })
    expect(h.store.getState().link).toMatchObject({
      phase: 'incompatible',
      lastError: { code: 'unsupported' },
    })
    expect(await codeOf(h.client.call('auth.signIn', { origin: fake.origin }))).toBe(
      'unsupported',
    )
    expect(h.store.getState().capabilities['chat.stream']?.state).toBe('unavailable')
    expect(fake.calls.some((c) => c.name === 'GET /')).toBe(false)
  })

  it('refuses operations whose capability is not usable, with the reason', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake, signIn: false })
    expect(h.store.getState().link.phase).toBe('signed-out')
    const error = await h.client
      .call('conversations.list', {})
      .catch((e: unknown) => e as CindlError)
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'Sign in to Hermes first.',
    })
  })

  it('signs out locally and forgets the tokens', async () => {
    const h = await harness()
    await expect(h.client.call('auth.signOut', {})).resolves.toEqual({ localOnly: true })
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(h.secrets.map.size).toBe(0)
  })
})

describe('direct client: a subscriber that joins late', () => {
  it('is told the link, capabilities, conversations, prompts and requests so far', async () => {
    const base = memoryKv()
    let full = false
    // Once full, the device cannot record a prompt as sending, so it stays queued.
    const kv: KeyValueStore & { map: Map<string, string> } = {
      ...base,
      set: (key, value) =>
        full && value.includes('"state":"sending"')
          ? Promise.reject(new Error('disk full (fixture)'))
          : base.set(key, value),
    }
    const h = await harness({ kv })
    approvalScript(h)
    const { c, request } = await openRequest(h)
    full = true
    const stuck = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-stuck',
      text: 'later (fixture)',
    })
    expect(stuck.state).toBe('queued-offline')
    // An error boundary remounts the renderer, whose new store subscribes now.
    const late = createStore({
      phase: 'connecting',
      since: '2026-01-01T00:00:00.000Z',
      connectionEpoch: 0,
    })
    h.client.subscribe((event) => late.dispatch(event))
    const state = late.getState()
    expect(state.link).toEqual(h.store.getState().link)
    expect(state.link.phase).toBe('online')
    expect(state.capabilities).toEqual(h.store.getState().capabilities)
    expect(entry(state.conversations, c.id)?.title).toBe(c.title)
    expect(entry(state.requests, request.requestId)?.status).toBe('open')
    expect(entry(state.prompts, 'p-stuck')?.state).toBe('queued-offline')
    expect(state.display).toEqual(h.store.getState().display)
  })

  it('is not told the screen of the Hermes it left', async () => {
    const h = await harness()
    await h.waitFor(() => h.events.some((e) => e.type === 'display.changed'))
    // Hermes B cannot read its screen, so B reports none of its own.
    const b = await fakeHermes()
    b.gateway.respondError = (method) =>
      method === 'display.status'
        ? { code: 5000, message: 'display.status failed (fixture)' }
        : undefined
    await h.client.call('auth.signIn', { origin: b.origin })
    await h.waitFor(() => h.store.getState().link.server?.origin === b.origin)
    await online(h)
    const boot = {
      phase: 'connecting' as const,
      since: '2026-01-01T00:00:00.000Z',
      connectionEpoch: 0,
    }
    const late = createStore(boot)
    h.client.subscribe((event) => late.dispatch(event))
    expect(late.getState().link.server?.origin).toBe(b.origin)
    expect(late.getState().display).toEqual(createStore(boot).getState().display)
  })

  it('hears nothing before the client has reported a link', async () => {
    const fake = await fakeHermes()
    const client = createDirectClient({
      origin: fake.origin,
      auth: 'native-pkce',
      fetch: (url, init) => fetch(url, init),
      socketFactory: () => {
        throw new Error('not used (fixture)')
      },
      clock: systemClock,
      kv: memoryKv(),
      secrets: memorySecrets(),
      crypto: webCryptoProvider(),
    })
    const events: CindlEvent[] = []
    client.subscribe((event) => events.push(event))
    expect(events).toEqual([])
  })
})

describe('direct client: a failure on this device during discovery', () => {
  it('shows a secret store it cannot read as an error, not offline, and reads it again on start', async () => {
    const first = await harness()
    first.client.stop()
    // The same device starts again, and its secret store is locked at first.
    let locked = true
    const secrets: ReturnType<typeof memorySecrets> = {
      ...first.secrets,
      get: (key) =>
        locked
          ? Promise.reject(new Error('keystore locked (fixture)'))
          : first.secrets.get(key),
    }
    const h = await harness({ fake: first.fake, secrets, signIn: false })
    expect(h.store.getState().link).toMatchObject({
      phase: 'error',
      lastError: {
        code: 'internal',
        message: 'This device could not read its saved Hermes sign-in.',
      },
    })
    // Asking Hermes again cannot open the store, so discovery does not repeat.
    const statusReads = () =>
      h.fake.calls.filter((c) => c.name === 'GET /api/status').length
    const reads = statusReads()
    await pause(150)
    expect(statusReads()).toBe(reads)
    expect(h.store.getState().link.phase).toBe('error')
    // Once the store opens, the next start reads it again and connects.
    locked = false
    h.client.stop()
    await h.client.start()
    await online(h)
  })
})

describe('direct client: a late memory probe from the Hermes it left', () => {
  const memoryText = (h: Harness) => h.store.getState().capabilities['memory.text']?.state

  it("keeps memory.text as B answered it, whatever A's late probe says", async () => {
    const a = await fakeHermes()
    const probeA = a.holdNextRest('GET /api/learning/graph')
    const h = await harness({ fake: a })
    await probeA.arrived
    const b = await fakeHermes()
    await h.client.call('auth.signIn', { origin: b.origin })
    await h.waitFor(
      () =>
        h.store.getState().link.server?.origin === b.origin &&
        memoryText(h) === 'available',
    )
    // A answers only now, that it has no learning routes: nothing about B.
    probeA.release({ status: 404, body: { detail: 'Not Found' } })
    await pause(50)
    expect(memoryText(h)).toBe('available')
  })

  it('never shows memory.text as available on a Hermes that has not answered', async () => {
    const a = await fakeHermes()
    const probeA = a.holdNextRest('GET /api/learning/graph')
    const h = await harness({ fake: a })
    await probeA.arrived
    const b = await fakeHermes()
    const probeB = b.holdNextRest('GET /api/learning/graph')
    await h.client.call('auth.signIn', { origin: b.origin })
    await probeB.arrived
    // A's late answer says nothing about B, which has not answered yet.
    probeA.release()
    await pause(50)
    expect(memoryText(h)).not.toBe('available')
    probeB.release()
    await h.waitFor(() => memoryText(h) === 'available')
  })
})

describe('direct client: a sign-out during a native sign-in to another origin', () => {
  it('signs that sign-in out too: it stores nothing and the client stays where it was', async () => {
    // A browser leg the test holds open, as an owner still on the sign-in page.
    const leg: { hold: boolean; arrived: Promise<void>; release?: () => void } = {
      hold: false,
      arrived: Promise.resolve(),
    }
    let arrive: () => void = () => undefined
    leg.arrived = new Promise<void>((resolve) => (arrive = resolve))
    const authorizer = {
      async authorize(buildUrl: (redirectUri: string) => string) {
        if (leg.hold) {
          arrive()
          await new Promise<void>((resolve) => (leg.release = resolve))
        }
        const response = await fetch(buildUrl('http://127.0.0.1:53682/callback'), {
          redirect: 'manual',
        })
        return response.headers.get('location') ?? ''
      },
    }
    const h = await harness({ deps: { authorizer } })
    const a = h.fake
    const b = await fakeHermes()
    leg.hold = true
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await leg.arrived
    await h.client.call('auth.signOut', {})
    leg.release?.()
    expect(await signingIn).toBe('unauthenticated')
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
    // The next start finds the origin it had, signed out, and nothing of B.
    h.client.stop()
    await h.client.start()
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      server: { origin: a.origin },
    })
    expect(b.calls.filter((c) => c.name === '/api/ws')).toHaveLength(0)
  })
})

describe("direct client: the owner's Cancel of a native sign-in", () => {
  const CANCELLED = 'Sign-in was cancelled. Nothing was saved.'

  it("without a session: a Cancel during B's status read opens none, and the link says why", async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const status = b.holdNextRest('GET /api/status')
    const signingIn = h.client.call('auth.signIn', { origin: b.origin })
    await status.arrived
    h.client.cancelSignIn()
    status.release()
    await expect(signingIn).rejects.toMatchObject({
      code: 'unauthenticated',
      message: CANCELLED,
    })
    expect(browser.state.authorized).toBe(0)
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
    // The sign-in still owned the client, so its failure shows there.
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      server: { origin: b.origin },
      lastError: { code: 'unauthenticated', message: CANCELLED },
    })
    // Nothing was stopped: signing in again needs no start().
    await h.client.call('auth.signIn', { origin: b.origin })
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === b.origin,
    )
  })

  it("with a session: a Cancel during B's status read opens none and leaves the session as it was", async () => {
    const browser = recordingLeg()
    const h = await harness({ deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const authorized = browser.state.authorized
    const before = h.store.getState().link
    const status = b.holdNextRest('GET /api/status')
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await status.arrived
    h.client.cancelSignIn()
    status.release()
    expect(await signingIn).toBe('unauthenticated')
    expect(browser.state.authorized).toBe(authorized)
    expect(h.store.getState().link).toEqual(before)
    expect(await h.client.call('conversations.list', {})).toBeDefined()
  })

  it("a Cancel while B's stored sign-in is read opens none", async () => {
    const browser = recordingLeg()
    const base = memorySecrets()
    const hold: { key: string | undefined; arrived?: () => void; release?: () => void } =
      { key: undefined }
    const arrived = new Promise<void>((resolve) => (hold.arrived = resolve))
    const secrets: ReturnType<typeof memorySecrets> = {
      ...base,
      get: async (key) => {
        if (key === hold.key) {
          hold.key = undefined
          hold.arrived?.()
          await new Promise<void>((resolve) => (hold.release = resolve))
        }
        return base.get(key)
      },
    }
    const h = await harness({
      signIn: false,
      secrets,
      deps: { authorizer: browser.authorizer },
    })
    const b = await fakeHermes()
    hold.key = nativeTokensKey(b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await arrived
    h.client.cancelSignIn()
    hold.release?.()
    expect(await signingIn).toBe('unauthenticated')
    expect(browser.state.authorized).toBe(0)
  })

  it("a Cancel while the switch reads B's device state opens none", async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const read = holdDeviceRead(h, b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await read.arrived
    h.client.cancelSignIn()
    read.release()
    expect(await signingIn).toBe('unauthenticated')
    expect(browser.state.authorized).toBe(0)
  })

  it('a Cancel while the page is open cancels the leg and ends the sign-in at once', async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    browser.state.mode = 'wait'
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await browser.reached
    h.client.cancelSignIn()
    expect(
      await Promise.race([signingIn, pause(1_000).then(() => 'still waiting')]),
    ).toBe('unauthenticated')
    expect(browser.state.cancelled).toBe(1)
    expect(b.calls.filter((c) => c.name === 'POST /auth/native/token')).toHaveLength(0)
  })

  it('a Cancel after the browser answered: the sign-in still finishes and connects', async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const exchange = b.holdNextRest('POST /auth/native/token')
    const signingIn = h.client.call('auth.signIn', { origin: b.origin })
    await exchange.arrived
    h.client.cancelSignIn()
    exchange.release()
    await signingIn
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(true)
    expect(browser.state.cancelled).toBe(0)
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === b.origin,
    )
  })
})

describe('direct client: no browser after a stop()', () => {
  it("without a session: a stop() during B's status read opens none and stores nothing", async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const status = b.holdNextRest('GET /api/status')
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await status.arrived
    h.client.stop()
    status.release()
    expect(await signingIn).toBe('unavailable')
    expect(browser.state.authorized).toBe(0)
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
  })

  it("with a session: a stop() during B's status read opens none and stores nothing", async () => {
    const browser = recordingLeg()
    const h = await harness({ deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const authorized = browser.state.authorized
    const status = b.holdNextRest('GET /api/status')
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await status.arrived
    h.client.stop()
    status.release()
    expect(await signingIn).toBe('unavailable')
    expect(browser.state.authorized).toBe(authorized)
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
    expect(h.store.getState().link.server?.origin).toBe(h.fake.origin)
  })

  it("a stop() while B's stored sign-in is read opens none", async () => {
    const browser = recordingLeg()
    const base = memorySecrets()
    const hold: { key: string | undefined; arrived?: () => void; release?: () => void } =
      { key: undefined }
    const arrived = new Promise<void>((resolve) => (hold.arrived = resolve))
    const secrets: ReturnType<typeof memorySecrets> = {
      ...base,
      get: async (key) => {
        if (key === hold.key) {
          hold.key = undefined
          hold.arrived?.()
          await new Promise<void>((resolve) => (hold.release = resolve))
        }
        return base.get(key)
      },
    }
    const h = await harness({
      signIn: false,
      secrets,
      deps: { authorizer: browser.authorizer },
    })
    const b = await fakeHermes()
    hold.key = nativeTokensKey(b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await arrived
    h.client.stop()
    hold.release?.()
    expect(await signingIn).toBe('unavailable')
    expect(browser.state.authorized).toBe(0)
  })

  it('a stop() while the leg binds its listener opens no page, and the leg gives up', async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    browser.state.mode = 'bind'
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await browser.reached
    h.client.stop()
    browser.release()
    expect(await signingIn).toBe('unavailable')
    // The leg builds the page's address only after binding: that build fails.
    await expect(browser.state.settled).rejects.toMatchObject({ code: 'unavailable' })
    expect(browser.state.opened).toEqual([])
  })

  it('a stop() while the page is open cancels the leg and ends the sign-in at once', async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    browser.state.mode = 'wait'
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await browser.reached
    h.client.stop()
    expect(
      await Promise.race([signingIn, pause(1_000).then(() => 'still waiting')]),
    ).toBe('unavailable')
    expect(browser.state.cancelled).toBe(1)
    await expect(browser.state.settled).rejects.toMatchObject({ code: 'unavailable' })
    expect(b.calls.filter((c) => c.name === 'POST /auth/native/token')).toHaveLength(0)
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
  })

  it('a stop() after the browser answered lets the sign-in stand', async () => {
    const browser = recordingLeg()
    const h = await harness({ signIn: false, deps: { authorizer: browser.authorizer } })
    const b = await fakeHermes()
    const exchange = b.holdNextRest('POST /auth/native/token')
    const signingIn = h.client.call('auth.signIn', { origin: b.origin })
    await exchange.arrived
    h.client.stop()
    exchange.release()
    // Its tokens are stored, but nothing connects until start().
    expect(await signingIn).toMatchObject({
      phase: 'offline',
      server: { origin: b.origin },
    })
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(true)
    expect(browser.state.cancelled).toBe(0)
    expect(b.calls.filter((c) => c.kind === 'ws')).toHaveLength(0)
    await h.client.start()
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === b.origin,
    )
  })
})

describe('direct client: a sign-out while a sign-in to another origin stores its tokens', () => {
  it('still keeps the client where it was', async () => {
    const base = memorySecrets()
    const writing: { key?: string; arrived?: () => void; release?: () => void } = {}
    const arrived = new Promise<void>((resolve) => (writing.arrived = resolve))
    // The device's store holds the write of B's tokens until the test lets it go.
    const secrets: ReturnType<typeof memorySecrets> = {
      ...base,
      set: async (key, value) => {
        if (key === writing.key) {
          writing.arrived?.()
          await new Promise<void>((resolve) => (writing.release = resolve))
        }
        return base.set(key, value)
      },
    }
    const h = await harness({ secrets })
    const a = h.fake
    const b = await fakeHermes()
    writing.key = nativeTokensKey(b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await arrived
    await h.client.call('auth.signOut', {})
    writing.release?.()
    expect(await signingIn).toBe('unauthenticated')
    h.client.stop()
    await h.client.start()
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      server: { origin: a.origin },
    })
  })
})

describe('direct client: a sign-out before a native sign-in opens the browser', () => {
  /** A browser leg that counts how often the browser was opened. */
  function countingAuthorizer() {
    const opened = { count: 0 }
    return {
      opened,
      authorizer: {
        async authorize(buildUrl: (redirectUri: string) => string) {
          opened.count++
          const response = await fetch(buildUrl('http://127.0.0.1:53682/callback'), {
            redirect: 'manual',
          })
          return response.headers.get('location') ?? ''
        },
      },
    }
  }

  const tokenExchanges = (fake: { calls: Array<{ name: string }> }) =>
    fake.calls.filter((c) => c.name === 'POST /auth/native/token').length

  it("signed in to A: a sign-out during B's status read opens no browser and stores nothing", async () => {
    const leg = countingAuthorizer()
    const h = await harness({ deps: { authorizer: leg.authorizer } })
    const b = await fakeHermes()
    const statusB = b.holdNextRest('GET /api/status')
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await statusB.arrived
    const opened = leg.opened.count
    await h.client.call('auth.signOut', {})
    statusB.release()
    expect(await signingIn).toBe('unauthenticated')
    expect(leg.opened.count).toBe(opened)
    expect(tokenExchanges(b)).toBe(0)
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      server: { origin: h.fake.origin },
    })
  })

  it("signed in to A: a sign-out while B's stored sign-in is read does the same", async () => {
    const leg = countingAuthorizer()
    const base = memorySecrets()
    const hold: { key: string | undefined; arrived?: () => void; release?: () => void } =
      {
        key: undefined,
      }
    const arrived = new Promise<void>((resolve) => (hold.arrived = resolve))
    const secrets: ReturnType<typeof memorySecrets> = {
      ...base,
      get: async (key) => {
        if (key === hold.key) {
          hold.key = undefined
          hold.arrived?.()
          await new Promise<void>((resolve) => (hold.release = resolve))
        }
        return base.get(key)
      },
    }
    const h = await harness({ secrets, deps: { authorizer: leg.authorizer } })
    const b = await fakeHermes()
    hold.key = nativeTokensKey(b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await arrived
    const opened = leg.opened.count
    await h.client.call('auth.signOut', {})
    hold.release?.()
    expect(await signingIn).toBe('unauthenticated')
    expect(leg.opened.count).toBe(opened)
    expect(tokenExchanges(b)).toBe(0)
    expect(base.map.has(nativeTokensKey(b.origin))).toBe(false)
  })

  it("not signed in: a sign-out during B's status read leaves the client on B, signed out, nothing stored", async () => {
    const leg = countingAuthorizer()
    const h = await harness({ signIn: false, deps: { authorizer: leg.authorizer } })
    await h.waitFor(() => h.store.getState().link.phase === 'signed-out')
    const b = await fakeHermes()
    const statusB = b.holdNextRest('GET /api/status')
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await statusB.arrived
    await h.client.call('auth.signOut', {})
    statusB.release()
    expect(await signingIn).toBe('unauthenticated')
    expect(leg.opened.count).toBe(0)
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
    // Without a working session the client took up B as the sign-in began.
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      server: { origin: b.origin },
    })
  })

  it("not signed in: a sign-out while the switch loads B's device state never goes online", async () => {
    const leg = countingAuthorizer()
    const h = await harness({ signIn: false, deps: { authorizer: leg.authorizer } })
    await h.waitFor(() => h.store.getState().link.phase === 'signed-out')
    const b = await fakeHermes()
    const realGet = h.kv.get.bind(h.kv)
    const hold: { armed: boolean; arrived?: () => void; release?: () => void } = {
      armed: true,
    }
    const arrived = new Promise<void>((resolve) => (hold.arrived = resolve))
    h.kv.get = async (key: string) => {
      if (hold.armed && key.includes(`|${b.origin}|`)) {
        hold.armed = false
        hold.arrived?.()
        await new Promise<void>((resolve) => (hold.release = resolve))
      }
      return realGet(key)
    }
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await arrived
    await h.client.call('auth.signOut', {})
    hold.release?.()
    expect(await signingIn).toBe('unauthenticated')
    await pause(200)
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(leg.opened.count).toBe(0)
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
  })

  it('does not sign out a sign-in to another origin that already failed', async () => {
    const base = memorySecrets()
    const deleted: string[] = []
    const secrets: ReturnType<typeof memorySecrets> = {
      ...base,
      delete: (key) => {
        deleted.push(key)
        return base.delete(key)
      },
    }
    const h = await harness({ secrets })
    const b = await fakeHermes({ nativeSignIn: 'deny' })
    expect(await codeOf(h.client.call('auth.signIn', { origin: b.origin }))).toBe(
      'unauthenticated',
    )
    await h.client.call('auth.signOut', {})
    expect(deleted).toContain(nativeTokensKey(h.fake.origin))
    expect(deleted).not.toContain(nativeTokensKey(b.origin))
  })
})

describe('direct client: a sign-out whose own delete is slow', () => {
  it('signs out a sign-in in flight before waiting on that delete, so it never stores', async () => {
    const base = memorySecrets()
    const state: {
      holdKey?: string
      deleteArrived?: () => void
      releaseDelete?: () => void
      setsFor: string[]
    } = { setsFor: [] }
    const deleteArrived = new Promise<void>((resolve) => (state.deleteArrived = resolve))
    const secrets: ReturnType<typeof memorySecrets> = {
      ...base,
      set: (key, value) => {
        state.setsFor.push(key)
        return base.set(key, value)
      },
      delete: async (key) => {
        if (key === state.holdKey) {
          state.deleteArrived?.()
          await new Promise<void>((resolve) => (state.releaseDelete = resolve))
        }
        return base.delete(key)
      },
    }
    // B's browser leg waits until the test lets it go.
    const leg: { hold: boolean; arrived?: () => void; release?: () => void } = {
      hold: false,
    }
    const legArrived = new Promise<void>((resolve) => (leg.arrived = resolve))
    const authorizer = {
      async authorize(buildUrl: (redirectUri: string) => string) {
        if (leg.hold) {
          leg.arrived?.()
          await new Promise<void>((resolve) => (leg.release = resolve))
        }
        const response = await fetch(buildUrl('http://127.0.0.1:53682/callback'), {
          redirect: 'manual',
        })
        return response.headers.get('location') ?? ''
      },
    }
    const h = await harness({ secrets, deps: { authorizer } })
    const b = await fakeHermes()
    leg.hold = true
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await legArrived
    // A's own delete is slow; B's sign-in finishes its browser leg meanwhile.
    state.holdKey = nativeTokensKey(h.fake.origin)
    const signingOut = h.client.call('auth.signOut', {})
    await deleteArrived
    leg.release?.()
    expect(await signingIn).toBe('unauthenticated')
    state.releaseDelete?.()
    await signingOut
    expect(state.setsFor).not.toContain(nativeTokensKey(b.origin))
  })
})

describe('direct client: the switch after a sign-in with a working session', () => {
  it('fails the sign-in on a sign-out there: the client stays on A, signed out, with no tokens', async () => {
    const h = await harness()
    const b = await fakeHermes()
    const read = holdDeviceRead(h, b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await read.arrived
    // B's sign-in has stored its tokens by now; the switch is still to come.
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(true)
    await h.client.call('auth.signOut', {})
    read.release()
    expect(await signingIn).toBe('unauthenticated')
    await pause(100)
    expect(h.store.getState().link).toMatchObject({
      phase: 'signed-out',
      server: { origin: h.fake.origin },
    })
    expect(h.secrets.map.has(nativeTokensKey(b.origin))).toBe(false)
    expect(h.secrets.map.has(nativeTokensKey(h.fake.origin))).toBe(false)
    expect(b.calls.filter((c) => c.kind === 'ws')).toHaveLength(0)
  })

  it("reads B's device state once, before its checks, with nothing read after them", async () => {
    const h = await harness()
    const b = await fakeHermes()
    const reads = deviceReads(h, b.origin)
    await h.client.call('auth.signIn', { origin: b.origin })
    expect(reads.sort()).toEqual(['accepted', 'epoch', 'main', 'outbox'])
  })

  it("saves B's outbox as the switch recovered it, and the store keeps it", async () => {
    const h = await harness()
    const b = await fakeHermes()
    const outboxKey = await seedSendingPrompt(h.kv, b.origin)
    const links = linkLog(h)
    await h.client.call('auth.signIn', { origin: b.origin })
    await h.waitFor(
      () =>
        (JSON.parse(h.kv.map.get(outboxKey) ?? '[]') as Array<{ state?: string }>)[0]
          ?.state === 'uncertain',
    )
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === b.origin,
    )
    // The link named B before B's prompts came, so the store kept them.
    expect(entry(h.store.getState().prompts, 'p-was-sending')?.state).toBe('uncertain')
    // The sign-in succeeded, so B is connecting: never signed out or offline,
    // and A does not show offline on the way.
    expect(links[0]).toBe(`connecting@${b.origin}`)
    expect(new Set(links)).toEqual(
      new Set([`connecting@${b.origin}`, `online@${b.origin}`]),
    )
  })

  it('does not connect after a stop() there; the next start finds the sign-in', async () => {
    const h = await harness()
    const b = await fakeHermes()
    const a = await conversation(h)
    const read = holdDeviceRead(h, b.origin)
    const signingIn = h.client.call('auth.signIn', { origin: b.origin })
    await read.arrived
    h.client.stop()
    read.release()
    expect((await signingIn).server?.origin).toBe(b.origin)
    await pause(100)
    // Nothing connects, and the link says so for B, the origin it now has.
    expect(h.store.getState().link).toMatchObject({
      phase: 'offline',
      server: { origin: b.origin },
    })
    expect(entry(h.store.getState().conversations, a.id)).toBeUndefined()
    // The store holds what a renderer subscribing now is told: nothing of A.
    expectStoreMatchesSeed(h)
    expect(b.calls.filter((c) => c.kind === 'ws')).toHaveLength(0)
    // The switch took B's device state up, so the next start reads none of it.
    const reads = deviceReads(h, b.origin)
    await h.client.start()
    await h.waitFor(
      () =>
        h.store.getState().link.phase === 'online' &&
        h.store.getState().link.server?.origin === b.origin,
    )
    expect(reads).toEqual([])
  })
})

describe('direct client: a sign-out while an installed sign-in writes its tokens', () => {
  /** A store that applies writes in call order, and answers one key's write only when released. */
  function slowWriteSecrets() {
    const base = memorySecrets()
    const hold: { key: string | undefined; arrived?: () => void; release?: () => void } =
      {
        key: undefined,
      }
    const arrived = new Promise<void>((resolve) => (hold.arrived = resolve))
    const secrets: ReturnType<typeof memorySecrets> = {
      ...base,
      set: async (key, value) => {
        await base.set(key, value)
        if (key === hold.key) {
          hold.key = undefined
          hold.arrived?.()
          await new Promise<void>((resolve) => (hold.release = resolve))
        }
      },
    }
    return { base, secrets, hold, arrived }
  }

  it('fails a sign-in to another origin without a working session, and keeps no tokens', async () => {
    const s = slowWriteSecrets()
    const h = await harness({ signIn: false, secrets: s.secrets })
    await h.waitFor(() => h.store.getState().link.phase === 'signed-out')
    const b = await fakeHermes()
    s.hold.key = nativeTokensKey(b.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: b.origin }))
    await s.arrived
    await h.client.call('auth.signOut', {})
    s.hold.release?.()
    expect(await signingIn).toBe('unauthenticated')
    await pause(100)
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(s.base.map.has(nativeTokensKey(b.origin))).toBe(false)
  })

  it('fails a sign-in to the same origin, and keeps no tokens', async () => {
    const s = slowWriteSecrets()
    const h = await harness({ signIn: false, secrets: s.secrets })
    await h.waitFor(() => h.store.getState().link.phase === 'signed-out')
    s.hold.key = nativeTokensKey(h.fake.origin)
    const signingIn = codeOf(h.client.call('auth.signIn', { origin: h.fake.origin }))
    await s.arrived
    await h.client.call('auth.signOut', {})
    s.hold.release?.()
    expect(await signingIn).toBe('unauthenticated')
    await pause(100)
    expect(h.store.getState().link.phase).toBe('signed-out')
    expect(s.base.map.has(nativeTokensKey(h.fake.origin))).toBe(false)
  })
})
