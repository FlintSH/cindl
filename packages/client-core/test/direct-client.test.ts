import { CindlError, type Conversation } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { selectOpenRequests, sha256Hex } from '../src/index.ts'
import { fakeHermes, harness, type Harness } from './direct-harness.ts'

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof CindlError ? error.code : String(error)),
  )

async function conversation(h: Harness, title = 'Side (fixture)'): Promise<Conversation> {
  return h.client.call('conversations.create', { title })
}

function assistantText(h: Harness, conversationId: string): string {
  const messages = h.store.getState().messages[conversationId] ?? []
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
}

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
    expect(caps['soul.write']?.state).toBe('limited')
    expect(caps['memory.text']?.state).toBe('unsupported')
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
    expect(conversations[a.id]?.kind).toBe('side')
    expect(conversations[b.id]?.kind).toBe('main')
    expect([...h.kv.map.values()]).toContain(JSON.stringify(b.id))
  })
})

describe('direct client: approvals and questions', () => {
  async function approvalTurn(
    h: Harness,
    choices: Array<'once' | 'session' | 'always' | 'deny'> = [
      'once',
      'session',
      'always',
      'deny',
    ],
  ) {
    const outcome: { result?: unknown } = {}
    h.fake.gateway.script = async (turn) => {
      outcome.result = await turn.approval({ choices: [...choices] })
      await turn.reply('done')
    }
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'export it',
    })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    return { c, request, outcome }
  }

  it('answers an approval once, with an offered choice, and rejects a second answer locally', async () => {
    const h = await harness()
    const { c, request, outcome } = await approvalTurn(h)
    expect(request).toMatchObject({
      kind: 'approval',
      conversationId: c.id,
      choices: ['once', 'deny'],
      withheldChoices: ['session', 'always'],
      status: 'open',
    })
    expect(request.requestId).toMatch(/^srq-/)
    expect(h.store.getState().conversations[c.id]?.status).toBe('waiting-on-you')
    const answered = await h.client.call('request.answer', {
      requestId: request.requestId,
      answer: { kind: 'approval', choice: 'once' },
    })
    expect(answered.status).toBe('answered')
    await h.waitFor(() => outcome.result)
    expect(outcome.result).toEqual({ choice: 'once' })
    expect(
      await codeOf(
        h.client.call('request.answer', {
          requestId: request.requestId,
          answer: { kind: 'approval', choice: 'deny' },
        }),
      ),
    ).toBe('not-found')
    expect(h.store.getState().requests[request.requestId]?.status).toBe('answered')
    expect(h.fake.gateway.droppedResponses).toEqual([])
  })

  it('refuses a choice Hermes did not offer without sending anything', async () => {
    const h = await harness()
    const { request } = await approvalTurn(h, ['deny'])
    expect(
      await codeOf(
        h.client.call('request.answer', {
          requestId: request.requestId,
          answer: { kind: 'approval', choice: 'once' },
        }),
      ),
    ).toBe('invalid')
    expect(h.fake.gateway.open.has(request.requestId)).toBe(true)
  })

  it('closes a request Hermes withdrew and refuses to answer it afterwards', async () => {
    const h = await harness()
    const { request } = await approvalTurn(h)
    h.fake.gateway.expireRequest(request.requestId)
    await h.waitFor(
      () => h.store.getState().requests[request.requestId]?.status === 'expired',
    )
    expect(
      await codeOf(
        h.client.call('request.answer', {
          requestId: request.requestId,
          answer: { kind: 'approval', choice: 'once' },
        }),
      ),
    ).toBe('not-found')
  })

  it('maps an interrupt to cancelled approvals', async () => {
    const h = await harness()
    const { c, request } = await approvalTurn(h)
    await h.client.call('conversation.interrupt', { conversationId: c.id })
    await h.waitFor(
      () => h.store.getState().requests[request.requestId]?.status === 'cancelled',
    )
  })

  it('answers a clarify set in one submission covering every question', async () => {
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
      await turn.reply('ok')
    }
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'book it',
    })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    expect(request.questions?.map((q) => [q.qid, q.multiSelect])).toEqual([
      ['q0', false],
      ['q1', true],
    ])
    expect(
      await codeOf(
        h.client.call('request.answer', {
          requestId: request.requestId,
          answer: { kind: 'clarify', answers: { q0: { choices: ['North'] } } },
        }),
      ),
    ).toBe('invalid')
    await h.client.call('request.answer', {
      requestId: request.requestId,
      answer: {
        kind: 'clarify',
        answers: { q0: { choices: ['North'] }, q1: { choices: ['Mon', 'Tue'] } },
      },
    })
    await h.waitFor(() => outcome.result)
    expect(outcome.result).toEqual({ answers: { q0: 'North', q1: '["Mon","Tue"]' } })
  })

  it('tells the user about a credential prompt it leaves to other clients', async () => {
    const h = await harness()
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'x',
    })
    const sid = c.session.runtimeId ?? ''
    void h.fake.gateway.serverRequest(sid, 'sudo', { command: 'apt list (fixture)' })
    await h.waitFor(() =>
      h.store.getState().notices.some((n) => n.message.includes('(sudo)')),
    )
    expect([...h.fake.gateway.open.values()].map((r) => r.method)).toEqual(['sudo'])
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
    await h.waitFor(
      () =>
        h.store.getState().link.connectionEpoch === 2 &&
        h.store.getState().link.phase === 'online',
    )
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
    expect(h.rpcCalls('session.events.since')).toBe(1)
    expect(h.events.some((e) => e.type === 'requests.synced')).toBe(true)
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
    expect(h.store.getState().messages[c.id]).toBeUndefined()
    await h.waitFor(() => h.store.getState().link.phase === 'online')
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

  it('closes requests another client answered while it was away', async () => {
    const h = await harness()
    h.fake.gateway.script = async (turn) => {
      await turn.approval()
    }
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'x',
    })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    h.fake.gateway.frozen = true
    const [open] = [...h.fake.gateway.open.values()]
    h.fake.gateway.frozen = false
    // Another surface settles it, then Cindl's socket drops.
    open?.settle({ choice: 'deny' })
    h.fake.gateway.open.delete(request.requestId)
    h.fake.gateway.dropConnections()
    await h.waitFor(
      () =>
        h.store.getState().requests[request.requestId]?.status === 'resolved-elsewhere',
    )
  })

  it('re-sends its own answer when Hermes still waits after a lost reply', async () => {
    const h = await harness()
    const outcome: { result?: unknown } = {}
    h.fake.gateway.script = async (turn) => {
      outcome.result = await turn.approval()
    }
    const c = await conversation(h)
    await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p1',
      text: 'x',
    })
    const request = await h.waitFor(() => selectOpenRequests(h.store.getState())[0])
    h.fake.gateway.frozen = true
    await h.client.call('request.answer', {
      requestId: request.requestId,
      answer: { kind: 'approval', choice: 'deny' },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    h.fake.gateway.frozen = false
    expect(h.fake.gateway.open.has(request.requestId)).toBe(true)
    h.fake.gateway.dropConnections()
    await h.waitFor(() => outcome.result)
    expect(outcome.result).toEqual({ choice: 'deny' })
    expect(h.store.getState().requests[request.requestId]?.status).toBe('answered')
  })
})

describe('direct client: prompts are never resent once uncertain', () => {
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
    await h.waitFor(
      () =>
        h.store.getState().link.connectionEpoch === 2 &&
        h.store.getState().link.phase === 'online',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    // The same client id is never sent again, even if the UI retries.
    expect(
      (
        await h.client.call('prompt.submit', {
          conversationId: c.id,
          clientId: 'p-lost',
          text: 'charge the card',
        })
      ).state,
    ).toBe('uncertain')
    expect(h.rpcCalls('prompt.submit')).toBe(1)
    // A restarted app recovers it as uncertain and still does not send it.
    h.client.stop()
    const again = await harness({ fake, kv: h.kv, secrets: h.secrets })
    expect(again.store.getState().prompts['p-lost']?.state).toBe('uncertain')
    expect(again.rpcCalls('prompt.submit')).toBe(1)
    await expect(
      again.client.call('prompt.discard', { clientId: 'p-lost' }),
    ).resolves.toEqual({ discarded: true })
  })

  it('queues a prompt while offline and sends it once the link is back', async () => {
    const fake = await fakeHermes()
    const h = await harness({ fake })
    const c = await conversation(h)
    fake.gateway.frozen = true
    fake.gateway.dropConnections()
    await h.waitFor(() => h.store.getState().link.phase !== 'online')
    const queued = await h.client.call('prompt.submit', {
      conversationId: c.id,
      clientId: 'p-q',
      text: 'later',
    })
    expect(queued.state).toBe('queued-offline')
    fake.gateway.frozen = false
    await h.waitFor(() => h.store.getState().prompts['p-q']?.state === 'accepted')
    expect(h.rpcCalls('prompt.submit')).toBe(1)
  })
})

describe('direct client: owner edits, routines, connections, screen', () => {
  it('writes SOUL.md only when the reviewed version still matches', async () => {
    const h = await harness()
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
    const profile = h.fake.store.profile('default')
    const entry = profile.skills.get('fixture-notes')
    if (entry) entry.content += '\nedited elsewhere (fixture)\n'
    expect(
      await codeOf(
        h.client.call('skills.write', {
          name: 'fixture-notes',
          content: 'x',
          expectedVersion: skill.version,
          confirm: true,
        }),
      ),
    ).toBe('conflict')
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
    expect(h.fake.calls.some((c) => /connectors|\/api\/fs|learning/.test(c.name))).toBe(
      false,
    )
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
