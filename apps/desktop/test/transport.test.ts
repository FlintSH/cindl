/**
 * The real desktop wiring (platform/index.ts + session.ts) against the
 * shared fake `hermes serve` from @cindl/fixtures: the direct client, the
 * safeStorage secret store (with a fake keyring), the settings store, the
 * ticket-subprotocol WebSocket factory, the screen socket and the 127.0.0.1
 * loopback listener (harness: support/desktop.ts).
 */
import { entry, selectOpenRequests } from '@cindl/client-core'
import {
  CindlError,
  type CapabilityId,
  type DisplayFrame,
  type OpArgs,
  type OpName,
  type OpResult,
  type ServerRequest,
} from '@cindl/contracts'
import type { FetchLike } from '@cindl/hermes-adapter'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIpcHandlers, type IpcEventLike } from '../src/main/ipc.ts'
import { ORIGIN_KEY } from '../src/main/platform/index.ts'
import {
  codeOf,
  desktop,
  fakeHermes,
  noKeyring,
  runCleanups,
  signIn,
  userData,
  type Desktop,
} from './support/desktop.ts'

afterEach(runCleanups)

const capability = (d: Desktop, id: CapabilityId) =>
  d.store.getState().capabilities[id]?.state

/** The synthetic screen (packages/fixtures/src/scenario/screen.ts). */
const SCREEN = { width: 640, height: 400 }
const BAR = [31, 42, 48]
const LABEL = [236, 228, 214]
const WINDOW = [244, 239, 230]
const POINTER = [230, 120, 40]

/** The colour at (x, y), from whichever region of the frame covers it. */
function pixel(frame: DisplayFrame, x: number, y: number): number[] | undefined {
  for (const region of frame.regions) {
    if (x < region.x || y < region.y) continue
    if (x >= region.x + region.width || y >= region.y + region.height) continue
    const at = ((y - region.y) * region.width + (x - region.x)) * 4
    return [...region.rgba.subarray(at, at + 3)]
  }
  return undefined
}

/** The top frame of the app window, as main's sender check expects it. */
const WINDOW_ID = 1
const fromApp: IpcEventLike = {
  sender: { id: WINDOW_ID },
  senderFrame: {
    url: 'app://cindl/index.html#/work',
    origin: 'app://cindl',
    parent: null,
  },
}

/**
 * The renderer's side of main's IPC handlers. Electron copies every reply
 * with V8's structured clone, as `structuredClone` does, so what a call
 * returns here is what arrives in the renderer.
 */
function rendererBridge(d: Desktop) {
  const handlers = createIpcHandlers({
    trustedContentsId: () => WINDOW_ID,
    client: d.real.client,
    saveText: () => Promise.resolve({ saved: false }),
    consumeGesture: () => false,
    openExternal: () => Promise.resolve({ opened: false }),
    onEventSignal: () => undefined,
    log: d.log,
  })
  /** Every reply that crossed to the renderer. */
  const received: unknown[] = []
  return {
    received,
    async call<K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>> {
      const reply = structuredClone(await handlers.call(fromApp, name, args))
      received.push(reply)
      if (!reply.ok) throw new CindlError(reply.error.code, reply.error.message)
      return reply.value as OpResult<K>
    },
  }
}
type RendererBridge = ReturnType<typeof rendererBridge>

/** Pull frames, as the viewer does after each paint, until (x, y) shows `colour`. */
async function frameShowing(
  renderer: RendererBridge,
  viewId: string,
  at: { x: number; y: number },
  colour: number[],
): Promise<DisplayFrame> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const frame = await renderer.call('display.frame', { viewId })
    if (JSON.stringify(pixel(frame, at.x, at.y)) === JSON.stringify(colour)) return frame
  }
  throw new Error(`no frame showed ${colour.join(',')} at ${at.x},${at.y}`)
}

describe(
  'desktop: a stop() during a sign-in, as at will-quit',
  { timeout: 30_000 },
  () => {
    it('not signed in: a stop() during the status read opens no browser', async () => {
      const fake = await fakeHermes()
      const d = await desktop(userData())
      const status = fake.holdNextRest('GET /api/status')
      const signingIn = codeOf(d.real.client.call('auth.signIn', { origin: fake.origin }))
      await status.arrived
      d.real.stop()
      status.release()
      expect(await signingIn).toBe('unavailable')
      expect(d.openBrowser).not.toHaveBeenCalled()
      expect(d.secretEntries()).toEqual([])
    })

    it("signed in: a stop() during another Hermes's status read opens no browser", async () => {
      const a = await fakeHermes()
      const b = await fakeHermes()
      const d = await desktop(userData())
      await signIn(d, a.origin)
      expect(d.openBrowser).toHaveBeenCalledTimes(1)
      const status = b.holdNextRest('GET /api/status')
      const signingIn = codeOf(d.real.client.call('auth.signIn', { origin: b.origin }))
      await status.arrived
      d.real.stop()
      status.release()
      expect(await signingIn).toBe('unavailable')
      expect(d.openBrowser).toHaveBeenCalledTimes(1)
      expect(b.calls.filter((c) => c.name === 'POST /auth/native/token')).toEqual([])
    })

    it('a stop() while the browser is open closes the loopback listener', async () => {
      const fake = await fakeHermes()
      const d = await desktop(userData())
      // The page opens, and nobody signs in on it.
      d.openBrowser.mockImplementationOnce(() => Promise.resolve())
      const signingIn = codeOf(d.real.client.call('auth.signIn', { origin: fake.origin }))
      await d.waitFor(() => d.openBrowser.mock.calls.length === 1)
      const redirect = new URL(d.openBrowser.mock.calls[0]?.[0] ?? '').searchParams.get(
        'redirect_uri',
      )
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      d.real.stop()
      expect(await signingIn).toBe('unavailable')
      // Nothing listens there any more.
      await expect(fetch(redirect ?? '')).rejects.toThrow()
    })
  },
)

describe('desktop wiring against a fake hermes serve', { timeout: 30_000 }, () => {
  it('signs in through the loopback leg, connects, answers an approval and signs out locally', async () => {
    const fake = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    expect(d.link().phase).toBe('unconfigured')

    await signIn(d, `${fake.origin}/`)
    // Main asked first, with the normalized origin; the browser leg went to Hermes.
    expect(d.confirmSignIn).toHaveBeenCalledWith(fake.origin)
    expect(d.openBrowser).toHaveBeenCalledTimes(1)
    expect(new URL(d.openBrowser.mock.calls[0]?.[0] ?? '').pathname).toBe(
      '/auth/native/authorize',
    )
    expect(d.link()).toMatchObject({ phase: 'online', auth: 'native-pkce' })
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        { kind: 'rest', name: 'POST /auth/native/token' },
        { kind: 'ws', name: '/api/ws' },
      ]),
    )
    // Tokens are in the encrypted store under this origin, and the origin is remembered.
    expect(d.secretEntries()).toEqual([expect.stringContaining(fake.origin)])
    expect(readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toMatch(
      /access_token|refresh_token/,
    )
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(fake.origin)

    const listed = await d.real.client.call('conversations.list', {})
    expect(Array.isArray(listed)).toBe(true)
    expect(fake.calls).toContainEqual({ kind: 'rpc', name: 'session.list' })

    const outcome: { result?: unknown } = {}
    fake.gateway.script = async (turn) => {
      outcome.result = await turn.approval({ choices: ['once', 'deny'] })
    }
    const conversation = await d.real.client.call('conversations.create', {
      title: 'Kiln check (fixture)',
    })
    await d.real.client.call('prompt.submit', {
      conversationId: conversation.id,
      clientId: 'transport-test-1',
      text: 'export it',
    })
    const request = await d.waitFor(() =>
      selectOpenRequests(d.store.getState()).find(
        (r) => r.conversationId === conversation.id && r.kind === 'approval',
      ),
    )
    const answered = await d.real.client.call('request.answer', {
      requestId: request.requestId,
      answer: { kind: 'approval', choice: 'once' },
    })
    expect(answered.status).toBe('answered')
    await d.waitFor(
      () => entry(d.store.getState().requests, request.requestId)?.status === 'answered',
    )
    await d.waitFor(() => outcome.result)

    expect(await d.real.client.call('auth.signOut', {})).toEqual({ localOnly: true })
    expect(d.link().phase).toBe('signed-out')
    // Tokens are gone from disk; the origin is kept for the next sign-in.
    expect(d.secretEntries()).toEqual([])
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(fake.origin)
    const again = await desktop(dir)
    await again.waitFor(() => again.link().phase === 'signed-out')
    expect(again.link().server?.origin).toBe(fake.origin)
  })

  it('announces where it starts once: unconfigured, with its capabilities', async () => {
    const d = await desktop(userData())
    const links = d.events.flatMap((event) =>
      event.type === 'link.changed' ? [event.link.phase] : [],
    )
    expect(links).toEqual(['unconfigured'])
    expect(
      d.events.filter((event) => event.type === 'capabilities.changed'),
    ).toHaveLength(1)
  })

  it('shows the agent screen through IPC, sends input only in control and keeps the ticket in main', async () => {
    const fake = await fakeHermes()
    const urls: string[] = []
    const d = await desktop(userData(), { onDisplaySocket: (url) => urls.push(url) })
    await signIn(d, fake.origin)
    // The screen runs and main can open its socket, so the live picture is offered.
    await d.waitFor(() => capability(d, 'computer.view') === 'available')
    expect(capability(d, 'computer.control')).toBe('available')
    const renderer = rendererBridge(d)

    const view = await renderer.call('display.watch', {})
    expect(view).toMatchObject(SCREEN)
    // The first frame is the whole screen: one region whose array holds exactly its pixels.
    const first = await renderer.call('display.frame', { viewId: view.viewId })
    expect(first.regions).toHaveLength(1)
    const rgba = first.regions[0]?.rgba
    expect(rgba).toBeInstanceOf(Uint8Array)
    expect(rgba?.byteLength).toBe(SCREEN.width * SCREEN.height * 4)
    expect(rgba?.buffer.byteLength).toBe(rgba?.byteLength)
    expect(pixel(first, 2, 2)).toEqual(BAR)
    // The first stroke of the "S" of "SYNTHETIC DEMO SCREEN", and the bar beside it.
    expect(pixel(first, 14, 7)).toEqual(LABEL)
    expect(pixel(first, 12, 7)).toEqual(BAR)
    expect(pixel(first, 300, 200)).toEqual(WINDOW)

    // Watching only: main refuses input, and nothing reaches Hermes.
    const press = { type: 'pointer', x: 300, y: 200, buttons: 0 } as const
    expect(
      await codeOf(
        renderer.call('display.input', { viewId: view.viewId, events: [press] }),
      ),
    ).toBe('forbidden')
    const [viewer] = fake.gateway.displayViewers
    expect(viewer?.filter).toMatchObject({ passedInput: 0, droppedInput: 0 })

    const control = await renderer.call('display.acquireControl', { confirm: true })
    expect(control.leaseHeldByThisDevice).toBe(true)
    expect(
      await renderer.call('display.input', { viewId: view.viewId, events: [press] }),
    ).toEqual({ sent: 1 })
    // The synthetic screen draws an orange marker where the pointer is.
    await frameShowing(renderer, view.viewId, press, POINTER)
    expect(viewer?.filter).toMatchObject({ passedInput: 1, droppedInput: 0 })

    expect(await renderer.call('display.unwatch', { viewId: view.viewId })).toEqual({
      stopped: true,
    })
    await d.waitFor(() => viewer?.closedWith)
    expect(viewer?.closedWith).toBe(1000)
    // Closing the view hands control back, as closing Hermes's own viewer does.
    await d.waitFor(() => fake.store.display.holder === 'agent')
    expect(await codeOf(renderer.call('display.frame', { viewId: view.viewId }))).toBe(
      'not-found',
    )

    // The ticket and the viewer id stayed in main: in no reply, event or log line.
    expect(urls).toHaveLength(1)
    const url = new URL(urls[0] ?? '')
    expect(url.pathname).toBe('/api/display/ws')
    const ticket = url.searchParams.get('display_ticket') ?? ''
    const crossed = JSON.stringify(
      [renderer.received, d.events],
      (_key, value: unknown) =>
        value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value,
    )
    for (const secret of [ticket, viewer?.viewerId ?? '']) {
      expect(secret).not.toBe('')
      expect(crossed).not.toContain(secret)
      expect(d.lines.join('\n')).not.toContain(secret)
    }
  })

  it('never answers a sudo prompt', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, fake.origin)
    const conversation = await d.real.client.call('conversations.create', {
      title: 'Sudo check (fixture)',
    })
    void fake.gateway.serverRequest(conversation.session.runtimeId ?? '', 'sudo', {
      command: 'apt list (fixture)',
    })
    const request: ServerRequest = await d.waitFor(() =>
      selectOpenRequests(d.store.getState()).find(
        (r) => r.conversationId === conversation.id,
      ),
    )
    expect(request).toMatchObject({ kind: 'unsupported', unsupportedKind: 'sudo' })
    expect(
      await codeOf(
        d.real.client.call('request.answer', {
          requestId: request.requestId,
          answer: { kind: 'approval', choice: 'deny' },
        }),
      ),
    ).toBe('unsupported')
    // No reply of any kind reached Hermes: the prompt is still open there.
    expect(
      fake.calls.filter((c) => c.kind === 'rpc' && c.name === 'request.answer'),
    ).toEqual([])
    expect([...fake.gateway.open.values()].map((r) => r.method)).toEqual(['sudo'])
    expect(fake.gateway.settled).toEqual([])
  })

  it('sends nothing until main confirms the origin', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData(), { confirm: false })
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: fake.origin }))).toBe(
      'forbidden',
    )
    expect(d.confirmSignIn).toHaveBeenCalledWith(fake.origin)
    expect(d.openBrowser).not.toHaveBeenCalled()
    expect(fake.calls).toEqual([])
    expect(d.platform.origin()).toBeUndefined()
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBeUndefined()
  })

  it('refuses a second sign-in while one waits for confirmation', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData())
    let release: (answer: boolean) => void = () => undefined
    d.confirmSignIn.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    )
    const first = d.real.client.call('auth.signIn', { origin: fake.origin })
    expect(await codeOf(d.real.client.call('auth.signIn', { origin: fake.origin }))).toBe(
      'unavailable',
    )
    release(false)
    expect(await codeOf(first)).toBe('forbidden')
  })

  it('never logs codes, verifiers or tokens', async () => {
    const fake = await fakeHermes()
    const d = await desktop(userData())
    await signIn(d, fake.origin)
    await d.real.client.call('conversations.list', {})
    const [key] = d.secretEntries()
    const tokens = JSON.parse(
      (await d.platform.secrets.get(key ?? '')) ?? '{}',
    ) as Record<string, unknown>
    const secrets = [tokens.access_token, tokens.refresh_token].filter(
      (value): value is string => typeof value === 'string',
    )
    expect(secrets).toHaveLength(2)
    const logged = d.lines.join('\n')
    for (const secret of secrets) expect(logged).not.toContain(secret)
    expect(logged).not.toMatch(/code_verifier=|[?&]code=[^[]/)
  })

  it('does not let a refresh that was in flight undo a sign-out', async () => {
    const fake = await fakeHermes()
    // Short-lived access tokens: every authenticated call refreshes first.
    fake.auth.accessTtlSeconds = 30
    const gate: {
      hold: boolean
      held: boolean
      reached?: () => void
      release?: () => void
    } = { hold: false, held: false }
    const reached = new Promise<void>((resolve) => (gate.reached = resolve))
    const held = new Promise<void>((resolve) => (gate.release = resolve))
    const fetchWithGate: FetchLike = async (url, init) => {
      if (gate.hold && new URL(url).pathname === '/auth/native/refresh') {
        gate.held = true
        gate.reached?.()
        await held
      }
      return fetch(url, init)
    }
    const dir = userData()
    const d = await desktop(dir, { fetch: fetchWithGate })
    await signIn(d, fake.origin)
    gate.hold = true
    // A call may reuse a refresh that was already in flight; the next one starts its own.
    const pending: Array<Promise<unknown>> = []
    for (let attempt = 0; attempt < 20 && !gate.held; attempt++) {
      pending.push(d.real.client.call('skills.list', {}).catch(() => undefined))
      await Promise.race([reached, new Promise((resolve) => setTimeout(resolve, 100))])
    }
    expect(gate.held).toBe(true)
    expect(await d.real.client.call('auth.signOut', {})).toEqual({ localOnly: true })
    gate.release?.()
    await Promise.all(pending)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(d.secretEntries()).toEqual([])
    const again = await desktop(dir)
    await again.waitFor(() => again.link().phase === 'signed-out')
  })

  it('does not use a token record copied under another origin', async () => {
    const first = await fakeHermes()
    const second = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    await signIn(d, first.origin)
    d.real.stop()
    // Same-user tampering: move the encrypted record and the stored origin.
    const file = path.join(dir, 'secrets.json')
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      entries: Record<string, string>
    }
    const [key] = Object.keys(data.entries)
    const moved = (key ?? '').replace(first.origin, second.origin)
    data.entries = { [moved]: data.entries[key ?? ''] ?? '' }
    writeFileSync(file, JSON.stringify(data))
    await d.platform.kv.set(ORIGIN_KEY, second.origin)
    const tampered = await desktop(dir)
    await tampered.waitFor(() => tampered.link().phase === 'signed-out')
    // The copied record never decrypted for the second origin: it received no
    // authenticated request at all, only the public status probe.
    expect(second.calls.filter((c) => c.name !== 'GET /api/status')).toEqual([])
  })

  it('forgets the previous origin’s tokens after signing in elsewhere', async () => {
    const first = await fakeHermes()
    const second = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir)
    await signIn(d, first.origin)
    await signIn(d, second.origin)
    expect(d.secretEntries()).toEqual([expect.stringContaining(second.origin)])
    expect(await d.platform.kv.get(ORIGIN_KEY)).toBe(second.origin)
  })

  it('keeps tokens in memory only, and says so, without a keyring', async () => {
    const fake = await fakeHermes()
    const dir = userData()
    const d = await desktop(dir, { safeStorage: noKeyring })
    expect(d.real.notices()).toEqual([
      expect.objectContaining({ type: 'notice', level: 'warning' }),
    ])
    await signIn(d, fake.origin)
    await d.real.client.call('conversations.list', {})
    expect(existsSync(path.join(dir, 'secrets.json'))).toBe(false)
    // A restart has nothing to sign in with.
    d.real.stop()
    const again = await desktop(dir, { safeStorage: noKeyring })
    await again.waitFor(() => again.link().phase === 'signed-out')
  })
})
