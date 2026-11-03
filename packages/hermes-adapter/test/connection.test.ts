import { describe, expect, it } from 'vitest'
import {
  bearerRest,
  captureLog,
  connection,
  fakeHermes,
  recorder,
  until,
} from './harness.ts'

describe('ticket + subprotocol connect', () => {
  it('opens /api/ws with a fresh ticket, reads gateway.ready and advertises server requests', async () => {
    const fake = await fakeHermes()
    const session = fake.signIn()
    const log = captureLog()
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, session), rec, {
      diagnostics: log.diagnostics,
    })
    conn.start()
    const online = await rec.waitFor((s) => s.phase === 'online')
    if (online.phase !== 'online') throw new Error('not online')
    expect(online.handshake).toMatchObject({
      connectionEpoch: 1,
      replayEpoch: fake.gateway.epoch,
      authority: 'legacy-sidecar-v8',
      sessionAuthority: false,
      heartbeat: true,
      declinesNotShown: true,
      perSessionExclusiveSubmit: true,
    })
    expect(online.handshake.serverRequests).toContain('approval')
    // client.capabilities is the first RPC on the socket, right after gateway.ready.
    const rpc = fake.calls.filter((c) => c.kind === 'rpc').map((c) => c.name)
    expect(rpc.slice(0, 2)).toEqual(['client.capabilities', 'gateway.capabilities'])
    expect(fake.calls.filter((c) => c.name === 'POST /api/auth/ws-ticket')).toHaveLength(
      1,
    )
    conn.stop()
    expect(log.text()).not.toContain(session.accessToken)
  })

  it('reconnects with a new ticket after a drop and bumps the connection epoch', async () => {
    const fake = await fakeHermes()
    const session = fake.signIn()
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, session), rec)
    conn.start()
    await rec.waitFor((s) => s.phase === 'online')
    fake.gateway.dropConnections()
    await rec.waitFor((s) => s.phase === 'reconnecting')
    const again = await rec.waitFor(
      (s) => s.phase === 'online' && s.handshake.connectionEpoch === 2,
    )
    if (again.phase !== 'online') throw new Error('not online')
    expect(again.handshake.previousReplayEpoch).toBe(fake.gateway.epoch)
    expect(fake.calls.filter((c) => c.name === 'POST /api/auth/ws-ticket')).toHaveLength(
      2,
    )
    conn.stop()
    await until(() => fake.gateway.connections.size === 0)
  })
})

describe('handshake refusals', () => {
  it('refuses an expired ticket and keeps retrying with fresh ones', async () => {
    const fake = await fakeHermes()
    const rest = bearerRest(fake, fake.signIn())
    const mint = rest.wsTicket.bind(rest)
    rest.wsTicket = async () => {
      const ticket = await mint()
      fake.advance(31_000)
      return ticket
    }
    const rec = recorder()
    const conn = connection(fake, rest, rec)
    conn.start()
    const state = await rec.waitFor((s) => s.phase === 'reconnecting' && s.attempt >= 2)
    expect(state.phase === 'reconnecting' && state.lastError?.code).toBe('unavailable')
    expect(fake.gateway.connections.size).toBe(0)
    conn.stop()
  })

  it('refuses a ticket that was already used, then recovers with a fresh one', async () => {
    const fake = await fakeHermes()
    const rest = bearerRest(fake, fake.signIn())
    const mint = rest.wsTicket.bind(rest)
    let reuse: Awaited<ReturnType<typeof mint>> | undefined
    let replays = 1
    rest.wsTicket = async () => {
      if (reuse && replays-- > 0) return reuse
      reuse = await mint()
      return reuse
    }
    const rec = recorder()
    const conn = connection(fake, rest, rec)
    conn.start()
    await rec.waitFor((s) => s.phase === 'online')
    fake.gateway.dropConnections()
    await rec.waitFor(
      (s) => s.phase === 'reconnecting' && s.lastError?.code === 'unavailable',
    )
    const online = await rec.waitFor(
      (s) => s.phase === 'online' && s.handshake.connectionEpoch === 2,
    )
    expect(online.phase).toBe('online')
    conn.stop()
  })

  it('is refused for a foreign Origin and accepted without one or from a trusted host', async () => {
    const fake = await fakeHermes({ publicHost: 'hermes.example.test' })
    const session = fake.signIn()
    const foreign = recorder()
    const bad = connection(fake, bearerRest(fake, session), foreign, {
      socket: { origin: 'https://cindl.example.test' },
    })
    bad.start()
    const refused = await foreign.waitFor(
      (s) => s.phase === 'reconnecting' && s.attempt >= 3,
    )
    expect(refused.phase === 'reconnecting' && refused.lastError?.message).toMatch(
      /Host\/Origin/,
    )
    bad.stop()
    for (const origin of [
      'https://hermes.example.test',
      'http://127.0.0.1:4173',
      'app://cindl',
    ]) {
      const rec = recorder()
      const conn = connection(fake, bearerRest(fake, session), rec, {
        socket: { origin },
      })
      conn.start()
      await rec.waitFor((s) => s.phase === 'online')
      conn.stop()
    }
  })

  it('stops as signed-out when Hermes is in loopback-token mode (no ws-ticket)', async () => {
    const fake = await fakeHermes({ mode: 'loopback' })
    const rec = recorder()
    const conn = connection(
      fake,
      bearerRest(fake, () => 'anything'),
      rec,
    )
    conn.start()
    const state = await rec.waitFor((s) => s.phase === 'signed-out')
    expect(state.phase === 'signed-out' && state.lastError.code).toBe('unauthenticated')
    expect(fake.calls.some((c) => c.name === '/api/ws')).toBe(false)
  })
})

describe('restarting a stalled socket', () => {
  it('drops a live socket and reconnects with a fresh ticket without reporting it online', async () => {
    const fake = await fakeHermes()
    let restartOnce = true
    const rec = recorder({
      onReady: (handshake) => {
        // The consumer cannot finish reconciling on the first socket.
        if (restartOnce && handshake.connectionEpoch === 1) {
          restartOnce = false
          conn.restart('reconciliation stalled (fixture)')
        }
        return Promise.resolve()
      },
    })
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec)
    conn.start()
    const online = await rec.waitFor((s) => s.phase === 'online')
    if (online.phase !== 'online') throw new Error('not online')
    expect(online.handshake.connectionEpoch).toBe(2)
    // Epoch 1 never reported online; the retry said why.
    expect(rec.states.filter((s) => s.phase === 'online')).toHaveLength(1)
    const retry = rec.states.find((s) => s.phase === 'reconnecting')
    expect(retry?.phase === 'reconnecting' && retry.lastError?.code).toBe('timeout')
    expect(fake.calls.filter((c) => c.name === 'POST /api/auth/ws-ticket')).toHaveLength(
      2,
    )
    conn.stop()
  })
})

describe('authority selection and version skew', () => {
  it('negotiates runtime.describe on a session-authority handshake and never sends sidecar methods', async () => {
    const fake = await fakeHermes({ sessionAuthority: true })
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec)
    conn.start()
    const online = await rec.waitFor((s) => s.phase === 'online')
    if (online.phase !== 'online') throw new Error('not online')
    expect(online.handshake.authority).toBe('canonical')
    expect(online.handshake.runtime?.profile_id).toBe('default')
    for (const method of ['gateway.capabilities', 'session.history', 'cron.manage'])
      await expect(conn.request(method)).rejects.toMatchObject({ code: 'protocol' })
    const rpc = fake.calls.filter((c) => c.kind === 'rpc').map((c) => c.name)
    expect(rpc).toEqual(['client.capabilities', 'runtime.describe'])
    conn.stop()
  })

  it.each([
    ['gateway.capabilities', 'unknown-method'],
    ['client.capabilities', 'params-out-of-sync'],
  ] as const)('marks the link incompatible when %s answers %s', async (method, mode) => {
    const fake = await fakeHermes()
    fake.gateway.failNext.set(method, mode)
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec)
    conn.start()
    const state = await rec.waitFor((s) => s.phase === 'incompatible')
    expect(state.phase === 'incompatible' && state.lastError.detail).toMatch(
      /-32601|4000/,
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(fake.calls.filter((c) => c.name === 'POST /api/auth/ws-ticket')).toHaveLength(
      1,
    )
  })

  it('turns a known method answered with -32601 mid-session into an incompatible link', async () => {
    const fake = await fakeHermes()
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec)
    conn.start()
    await rec.waitFor((s) => s.phase === 'online')
    fake.gateway.failNext.set('session.list', 'unknown-method')
    await expect(conn.request('session.list', {})).rejects.toMatchObject({
      code: 'unsupported',
    })
    await rec.waitFor((s) => s.phase === 'incompatible')
  })

  it('never puts a method outside the v0.22.5 allowlist on the wire', async () => {
    const fake = await fakeHermes()
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec)
    conn.start()
    await rec.waitFor((s) => s.phase === 'online')
    for (const method of [
      'connectors.list',
      'connectors.tools',
      'shell.exec',
      'vault.list',
    ])
      await expect(conn.request(method)).rejects.toMatchObject({ code: 'protocol' })
    expect(fake.calls.some((c) => /connectors|shell|vault/.test(c.name))).toBe(false)
    conn.stop()
  })
})

describe('liveness and timeouts', () => {
  it('drops a silent socket on the heartbeat deadline and reconnects', async () => {
    const fake = await fakeHermes()
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec, {
      heartbeatIntervalMs: 25,
      heartbeatDeadlineMs: 120,
    })
    conn.start()
    await rec.waitFor((s) => s.phase === 'online')
    fake.gateway.frozen = true
    await rec.waitFor((s) => s.phase === 'reconnecting')
    fake.gateway.frozen = false
    await rec.waitFor((s) => s.phase === 'online' && s.handshake.connectionEpoch === 2)
    conn.stop()
  })

  it('times out a request Hermes never answers without closing the link', async () => {
    const fake = await fakeHermes()
    const rec = recorder()
    const conn = connection(fake, bearerRest(fake, fake.signIn()), rec, {
      requestTimeoutMs: 60,
    })
    conn.start()
    await rec.waitFor((s) => s.phase === 'online')
    fake.gateway.failNext.set('session.list', 'no-response')
    await expect(conn.request('session.list', {})).rejects.toMatchObject({
      code: 'timeout',
    })
    await expect(conn.request('session.list', {})).resolves.toMatchObject({
      sessions: [],
    })
    conn.stop()
  })
})
