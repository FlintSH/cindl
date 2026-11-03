import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMenuTemplate, HANDBOOK_URL } from '../src/main/menu.ts'
import { createFileKeyValueStore } from '../src/main/platform/kv-store.ts'
import { validateSignInUrl } from '../src/main/platform/index.ts'
import { createTextSaver } from '../src/main/save-text.ts'
import { isAppUrl } from '../src/main/security.ts'
import {
  createWindowStateStore,
  DEFAULT_SIZE,
  MIN_SIZE,
  parseWindowState,
  placeWindow,
} from '../src/main/window-state.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cindl-desktop-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('navigation allowlist', () => {
  it('allows only the app origin', () => {
    expect(isAppUrl('app://cindl/index.html')).toBe(true)
    expect(isAppUrl('app://cindl/index.html#/work')).toBe(true)
    for (const url of [
      'https://example.test/',
      'app://cindl.example.test/',
      'app://evil/index.html',
      'app://x@cindl/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'not a url',
    ])
      expect(isAppUrl(url)).toBe(false)
  })
})

describe('sign-in browser URL', () => {
  it('opens only the Hermes authorize endpoint over a secure transport', () => {
    expect(
      validateSignInUrl('https://hermes.example.test/auth/native/authorize?state=x'),
    ).toBe('https://hermes.example.test/auth/native/authorize?state=x')
    expect(validateSignInUrl('http://127.0.0.1:9119/auth/native/authorize')).toBeDefined()
    for (const url of [
      'http://hermes.example.test/auth/native/authorize',
      'https://hermes.example.test/login',
      'https://owner:pw@hermes.example.test/auth/native/authorize',
      'wss://hermes.example.test/auth/native/authorize',
      'file:///auth/native/authorize',
      'javascript:alert(1)',
    ])
      expect(validateSignInUrl(url)).toBeUndefined()
  })
})

describe('application menu', () => {
  const roles = (devTools: boolean) =>
    JSON.stringify(buildMenuTemplate({ devTools, openHandbook: () => undefined }))

  it('hides developer tools unless they are allowed', () => {
    expect(roles(false)).not.toContain('toggleDevTools')
    expect(roles(false)).not.toContain('forceReload')
    expect(roles(true)).toContain('toggleDevTools')
  })

  it('uses standard roles and opens the handbook on request', () => {
    const openHandbook = vi.fn()
    const template = buildMenuTemplate({ devTools: false, openHandbook })
    for (const role of [
      'quit',
      'close',
      'copy',
      'paste',
      'undo',
      'selectAll',
      'reload',
      'about',
    ])
      expect(JSON.stringify(template)).toContain(`"role":"${role}"`)
    const help = template.find((item) => item.label === '&Help')?.submenu
    const entry = Array.isArray(help)
      ? help.find((item) => item.label?.includes('handbook'))
      : undefined
    ;(entry?.click as (() => void) | undefined)?.()
    expect(openHandbook).toHaveBeenCalledTimes(1)
    expect(HANDBOOK_URL).toMatch(/^https:\/\/github\.com\/FlintSH\/cindl\//)
  })
})

describe('window state', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 }

  it('parses only well-formed saved state', () => {
    expect(
      parseWindowState({ x: 10, y: 20, width: 900, height: 700, maximized: true }),
    ).toEqual({
      x: 10,
      y: 20,
      width: 900,
      height: 700,
      maximized: true,
    })
    expect(parseWindowState({ width: '900', height: 700 })).toBeUndefined()
    expect(parseWindowState({ width: 1e9, height: 700 })).toBeUndefined()
    expect(parseWindowState(null)).toBeUndefined()
  })

  it('uses defaults, clamps sizes and drops positions that are off screen', () => {
    expect(placeWindow(undefined, [screen])).toEqual({
      ...DEFAULT_SIZE,
      maximized: false,
    })
    expect(
      placeWindow({ width: 100, height: 100, maximized: false }, [screen]),
    ).toMatchObject(MIN_SIZE)
    expect(
      placeWindow({ width: 5000, height: 5000, maximized: false }, [screen]),
    ).toMatchObject({
      width: 1920,
      height: 1040,
    })
    expect(
      placeWindow({ x: 100, y: 100, width: 900, height: 700, maximized: false }, [
        screen,
      ]),
    ).toMatchObject({ x: 100, y: 100 })
    const gone = placeWindow(
      { x: 4000, y: 100, width: 900, height: 700, maximized: false },
      [screen],
    )
    expect(gone.x).toBeUndefined()
    expect(gone.y).toBeUndefined()
  })

  it('saves and loads atomically', async () => {
    const store = createWindowStateStore(path.join(dir, 'window-state.json'))
    expect(await store.load()).toBeUndefined()
    await store.save({ x: 1, y: 2, width: 800, height: 600, maximized: false })
    expect(await store.load()).toEqual({
      x: 1,
      y: 2,
      width: 800,
      height: 600,
      maximized: false,
    })
    writeFileSync(path.join(dir, 'window-state.json'), '{broken')
    expect(await store.load()).toBeUndefined()
  })
})

describe('settings store', () => {
  it('round-trips strings in an owner-only file and survives a restart', async () => {
    const file = path.join(dir, 'settings.json')
    const kv = createFileKeyValueStore(file)
    await kv.set('hermes.origin', 'https://hermes.example.test')
    await Promise.all([kv.set('a', '1'), kv.set('b', '2'), kv.delete('a')])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const reopened = createFileKeyValueStore(file)
    expect(await reopened.get('hermes.origin')).toBe('https://hermes.example.test')
    expect(await reopened.get('a')).toBeUndefined()
    expect(await reopened.get('b')).toBe('2')
    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual({
      'hermes.origin': 'https://hermes.example.test',
      b: '2',
    })
  })

  it('rejects bad keys and starts empty from a corrupt file', async () => {
    const file = path.join(dir, 'settings.json')
    writeFileSync(file, '[1,2')
    const warnings: string[] = []
    const kv = createFileKeyValueStore(file, (message) => warnings.push(message))
    expect(await kv.get('x')).toBeUndefined()
    expect(warnings).toHaveLength(1)
    await expect(kv.set('', 'x')).rejects.toThrow(TypeError)
    await expect(kv.set('k'.repeat(300), 'x')).rejects.toThrow(TypeError)
  })
})

describe('native save dialog', () => {
  it('writes where the owner chose, once, and respects cancel', async () => {
    const writes: Array<[string, string]> = []
    let answer: { canceled: boolean; filePath?: string } = {
      canceled: false,
      filePath: '/home/owner/Documents/kiln.md',
    }
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const save = createTextSaver({
      showSaveDialog: async (defaultPath) => {
        expect(defaultPath).toBe(path.join('/home/owner/Documents', 'kiln.md'))
        await gate
        return answer
      },
      writeFile: (file, content) => {
        writes.push([file, content])
        return Promise.resolve()
      },
      defaultDirectory: () => '/home/owner/Documents',
    })
    const first = save('kiln.md', 'notes')
    // A second request while the dialog is open is refused, not stacked.
    expect(await save('kiln.md', 'again')).toEqual({ saved: false })
    release()
    expect(await first).toEqual({ saved: true })
    expect(writes).toEqual([['/home/owner/Documents/kiln.md', 'notes']])
    answer = { canceled: true }
    expect(await save('kiln.md', 'notes')).toEqual({ saved: false })
    expect(writes).toHaveLength(1)
  })
})
