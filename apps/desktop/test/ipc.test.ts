import { CindlError, type OpName } from '@cindl/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  createIpcHandlers,
  isAppFrame,
  isTrustedSender,
  MAX_SAVE_TEXT_LENGTH,
  sanitizeFileName,
  toErrorShape,
  type IpcDeps,
  type IpcEventLike,
} from '../src/main/ipc.ts'
import { createLogger } from '../src/main/log.ts'

const WINDOW_ID = 7
const appFrame = {
  url: 'app://cindl/index.html#/talk',
  origin: 'app://cindl',
  parent: null,
}
const fromApp: IpcEventLike = { sender: { id: WINDOW_ID }, senderFrame: appFrame }

function setup(overrides: Partial<IpcDeps> = {}) {
  const lines: string[] = []
  const deps = {
    trustedContentsId: () => WINDOW_ID,
    client: {
      call: vi.fn((name: OpName, args: unknown) => Promise.resolve({ name, args })),
    },
    saveText: vi.fn(() => Promise.resolve({ saved: true })),
    openExternal: vi.fn(() => Promise.resolve({ opened: true })),
    onEventSignal: vi.fn(),
    log: createLogger({ write: (line) => lines.push(line) }),
  }
  return {
    deps,
    lines,
    handlers: createIpcHandlers({ ...deps, ...overrides } as IpcDeps),
  }
}

describe('sender validation', () => {
  it('accepts only the top-level app frame of the trusted window', () => {
    expect(isTrustedSender(fromApp, WINDOW_ID)).toBe(true)
    expect(isTrustedSender(fromApp, undefined)).toBe(false)
    expect(
      isTrustedSender({ ...fromApp, sender: { id: WINDOW_ID + 1 } }, WINDOW_ID),
    ).toBe(false)
  })

  it.each([
    [
      'a foreign https page',
      {
        url: 'https://evil.example.test/',
        origin: 'https://evil.example.test',
        parent: null,
      },
    ],
    ['a file:// page', { url: 'file:///etc/passwd', origin: 'file://', parent: null }],
    [
      'a look-alike host',
      { url: 'app://cindl.evil/index.html', origin: 'app://cindl.evil', parent: null },
    ],
    [
      'credentials in the URL',
      { url: 'app://x@cindl/index.html', origin: 'app://cindl', parent: null },
    ],
    [
      'a mismatched origin',
      { url: 'app://cindl/index.html', origin: 'null', parent: null },
    ],
    ['a subframe', { ...appFrame, parent: appFrame }],
    ['an unparseable URL', { url: 'not a url', origin: 'app://cindl', parent: null }],
  ])('refuses %s', (_label, frame) => {
    expect(isAppFrame(frame)).toBe(false)
    expect(
      isTrustedSender({ sender: { id: WINDOW_ID }, senderFrame: frame }, WINDOW_ID),
    ).toBe(false)
  })

  it('refuses a frame that is gone', () => {
    expect(
      isTrustedSender({ sender: { id: WINDOW_ID }, senderFrame: null }, WINDOW_ID),
    ).toBe(false)
  })
})

describe('cindl:call', () => {
  it('forwards a valid call with parsed arguments only', async () => {
    const { handlers, deps } = setup()
    const reply = await handlers.call(fromApp, 'conversations.rename', {
      conversationId: 'c1',
      title: 'Kiln notes',
      smuggled: 'shell.exec',
    })
    expect(reply).toEqual({
      ok: true,
      value: {
        name: 'conversations.rename',
        args: { conversationId: 'c1', title: 'Kiln notes' },
      },
    })
    expect(deps.client.call).toHaveBeenCalledTimes(1)
  })

  it.each([
    'shell.exec',
    'cli.exec',
    'vault.read',
    'rpc.call',
    'toString',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    'valueOf',
    '../x',
    '%2e%2e',
    '?a#b',
    'link.get/../soul.write',
    'LINK.GET',
    ' link.get',
    '',
    42,
    null,
    { toString: () => 'link.get' },
  ])('rejects the unknown operation %j without calling the client', async (name) => {
    const { handlers, deps } = setup()
    const reply = await handlers.call(fromApp, name, {})
    expect(reply).toEqual({
      ok: false,
      error: { code: 'invalid', message: 'Unknown Cindl operation.' },
    })
    expect(deps.client.call).not.toHaveBeenCalled()
  })

  it.each([
    ['prompt.submit', { conversationId: 'c1', clientId: 'p1', text: '' }],
    ['prompt.submit', { conversationId: 'c1', clientId: 'p1', text: 5 }],
    ['soul.write', { content: 'x', expectedVersion: 'stale', confirm: true }],
    ['soul.write', { content: 'x', expectedVersion: 'a'.repeat(64), confirm: false }],
    [
      'request.answer',
      { rpcId: 1, connectionEpoch: 1, answer: { kind: 'approval', choice: 'always' } },
    ],
    ['auth.signIn', { origin: 'file:///etc/passwd' }],
    ['auth.signIn', { origin: 'javascript:alert(1)' }],
    ['link.get', undefined],
    ['link.get', 'x'],
  ])('rejects bad arguments for %s', async (name, args) => {
    const { handlers, deps } = setup()
    const reply = await handlers.call(fromApp, name, args)
    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.error.code).toBe('invalid')
      expect(reply.error.message).toBe(`Invalid arguments for ${name}.`)
    }
    expect(deps.client.call).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>]>([
    ['conversations.history', { conversationId: '../x' }],
    ['conversations.history', { conversationId: '%2e%2e' }],
    ['conversations.history', { conversationId: '?a#b' }],
    ['conversations.history', { conversationId: 'a/b' }],
    ['conversations.history', { conversationId: '' }],
    ['conversations.setMain', { conversationId: '..' }],
    ['conversation.interrupt', { conversationId: 'x\u0000y' }],
    ['prompt.submit', { conversationId: 'c1', clientId: '../p1', text: 'hi' }],
    ['prompt.discard', { clientId: '%2e%2e' }],
    ['routines.setEnabled', { id: '?a#b', enabled: false, confirm: true }],
    ['skills.read', { name: '../SKILL' }],
    ['skills.read', { name: 'kiln%2f..' }],
    ['soul.read', { profile: '../default' }],
    ['soul.read', { profile: 'Default' }],
    [
      'request.answer',
      { requestId: '../srq-1', answer: { kind: 'approval', choice: 'deny' } },
    ],
    [
      'request.answer',
      { requestId: 'srq 1', answer: { kind: 'approval', choice: 'deny' } },
    ],
    [
      'request.answer',
      { requestId: 'srq-1', answer: { kind: 'approval', choice: 'deny' } },
    ],
    [
      'request.answer',
      { requestId: 'srq-0123456789AB', answer: { kind: 'approval', choice: 'deny' } },
    ],
    ['skills.read', { name: 'devops/../secrets' }],
    ['skills.read', { name: 'devops\\deploy' }],
  ])('rejects the hostile id in %s %j', async (name, args) => {
    const { handlers, deps } = setup()
    const reply = await handlers.call(fromApp, name, args)
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe('invalid')
    expect(deps.client.call).not.toHaveBeenCalled()
  })

  it.each([
    'http://hermes.example.test',
    'http://localhost:9119',
    'https://owner:pw@hermes.example.test',
    'https://hermes.example.test/path',
    'https://hermes.example.test/?q=1',
    'https://hermes.example.test/#x',
    'file:///etc/passwd',
  ])('rejects the sign-in origin %j (R4)', async (origin) => {
    const { handlers, deps } = setup()
    expect((await handlers.call(fromApp, 'auth.signIn', { origin })).ok).toBe(false)
    expect(deps.client.call).not.toHaveBeenCalled()
  })

  it('forwards well-formed request and skill ids', async () => {
    const { handlers, deps } = setup()
    const answer = await handlers.call(fromApp, 'request.answer', {
      requestId: 'srq-0123456789ab',
      answer: { kind: 'clarify', answers: { q0: { skipped: true } } },
    })
    expect(answer.ok).toBe(true)
    const skill = await handlers.call(fromApp, 'skills.read', { name: 'devops/deploy' })
    expect(skill.ok).toBe(true)
    expect(deps.client.call).toHaveBeenCalledTimes(2)
  })

  it('forwards only the normalized sign-in origin', async () => {
    const { handlers, deps } = setup()
    await handlers.call(fromApp, 'auth.signIn', {
      origin: 'HTTPS://Hermes.Example.Test:443/',
    })
    expect(deps.client.call).toHaveBeenCalledWith('auth.signIn', {
      origin: 'https://hermes.example.test',
    })
  })

  it('rejects the wrong number of IPC arguments', async () => {
    const { handlers, deps } = setup()
    expect((await handlers.call(fromApp, 'link.get')).ok).toBe(false)
    expect((await handlers.call(fromApp, 'link.get', {}, 'extra')).ok).toBe(false)
    expect(deps.client.call).not.toHaveBeenCalled()
  })

  it('refuses foreign senders before looking at the call', async () => {
    const { handlers, deps, lines } = setup()
    const foreign: IpcEventLike = {
      sender: { id: WINDOW_ID },
      senderFrame: {
        url: 'https://evil.example.test/',
        origin: 'https://evil.example.test',
        parent: null,
      },
    }
    const reply = await handlers.call(foreign, 'link.get', {})
    expect(reply).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'This window may not use Cindl.' },
    })
    expect(deps.client.call).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('Refused IPC from an untrusted sender')
  })

  it('passes CindlErrors through and hides unexpected errors', async () => {
    const conflict = setup({
      client: {
        call: () =>
          Promise.reject(
            new CindlError('conflict', 'SOUL.md changed since you opened it.'),
          ),
      },
    })
    expect(await conflict.handlers.call(fromApp, 'link.get', {})).toEqual({
      ok: false,
      error: { code: 'conflict', message: 'SOUL.md changed since you opened it.' },
    })
    const crash = setup({
      client: {
        call: () =>
          Promise.reject(
            new Error('socket hang up at wss://hermes.example.test/?ticket=abcdefgh123'),
          ),
      },
    })
    expect(await crash.handlers.call(fromApp, 'link.get', {})).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Cindl could not complete that request.' },
    })
    const logged = crash.lines.join('\n')
    expect(logged).toContain('socket hang up')
    expect(logged).not.toContain('abcdefgh123')
  })

  it('redacts secrets that slip into CindlError text', () => {
    const shape = toErrorShape(
      new CindlError(
        'unavailable',
        'Failed with Bearer abcdefghijklmnop1234',
        'GET /?code=topsecret99',
      ),
    )
    expect(JSON.stringify(shape)).not.toMatch(/abcdefghijklmnop1234|topsecret99/)
  })
})

describe('cindl:save-text', () => {
  it('saves under a sanitized base name', async () => {
    const { handlers, deps } = setup()
    expect(await handlers.saveText(fromApp, '../../.bashrc', 'transcript')).toEqual({
      ok: true,
      value: { saved: true },
    })
    expect(deps.saveText).toHaveBeenCalledWith('bashrc', 'transcript')
  })

  it.each<[unknown[], string]>([
    [['name.txt'], 'missing content'],
    [['name.txt', 5], 'non-string content'],
    [[{}, 'text'], 'non-string name'],
    [['name.txt', 'x'.repeat(MAX_SAVE_TEXT_LENGTH + 1)], 'oversized content'],
  ])('rejects %j (%s)', async (args, _label) => {
    const { handlers, deps } = setup()
    expect((await handlers.saveText(fromApp, ...args)).ok).toBe(false)
    expect(deps.saveText).not.toHaveBeenCalled()
  })

  it('refuses foreign senders', async () => {
    const { handlers, deps } = setup()
    const reply = await handlers.saveText({ ...fromApp, senderFrame: null }, 'a.txt', 'x')
    expect(reply.ok).toBe(false)
    expect(deps.saveText).not.toHaveBeenCalled()
  })

  it.each([
    ['transcript.md', 'transcript.md'],
    ['/etc/passwd', 'passwd'],
    ['..\\..\\windows\\system.ini', 'system.ini'],
    ['  .hidden  ', 'hidden'],
    ['a<b>c:d"e|f?g*h.txt', 'abcdefgh.txt'],
    ['bell\u0007\u0000name.txt', 'bellname.txt'],
    ['invoice\u202etxt.md', 'invoicetxt.md'],
    ['notes\u2066\u2069.md', 'notes.md'],
    ['...', 'cindl-export.txt'],
    ['', 'cindl-export.txt'],
    ['x'.repeat(300), 'x'.repeat(120)],
  ])('sanitizes %j to %j', (input, output) => {
    expect(sanitizeFileName(input)).toBe(output)
  })
})

describe('cindl:open-external', () => {
  it('hands exactly one argument to the validating opener', async () => {
    const { handlers, deps } = setup()
    expect(await handlers.openExternal(fromApp, 'https://example.test/')).toEqual({
      ok: true,
      value: { opened: true },
    })
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.test/')
    expect((await handlers.openExternal(fromApp)).ok).toBe(false)
    expect((await handlers.openExternal(fromApp, 'a', 'b')).ok).toBe(false)
  })

  it('refuses foreign senders', async () => {
    const { handlers, deps } = setup({ trustedContentsId: () => undefined })
    expect((await handlers.openExternal(fromApp, 'https://example.test/')).ok).toBe(false)
    expect(deps.openExternal).not.toHaveBeenCalled()
  })
})

describe('cindl:event signals', () => {
  it('accepts subscribe and unsubscribe from the app only', () => {
    const { handlers, deps } = setup()
    handlers.eventSignal(fromApp, 'subscribe')
    handlers.eventSignal(fromApp, 'unsubscribe')
    handlers.eventSignal(fromApp, 'flood')
    handlers.eventSignal(fromApp, 'subscribe', 'extra')
    handlers.eventSignal({ ...fromApp, sender: { id: 99 } }, 'subscribe')
    expect(deps.onEventSignal.mock.calls).toEqual([
      [WINDOW_ID, 'subscribe'],
      [WINDOW_ID, 'unsubscribe'],
    ])
  })
})
