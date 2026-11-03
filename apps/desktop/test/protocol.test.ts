import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assetSegments,
  CONTENT_SECURITY_POLICY,
  createAppProtocolHandler,
  isInside,
  mimeType,
} from '../src/main/protocol.ts'

let base: string
let root: string
const refused: string[] = []
let handle: ReturnType<typeof createAppProtocolHandler>

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cindl-protocol-'))
  root = path.join(base, 'renderer')
  mkdirSync(path.join(root, 'assets', 'nested'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Cindl</title>')
  writeFileSync(path.join(root, 'assets', 'app.js'), 'export {}')
  writeFileSync(path.join(root, 'assets', 'nested', 'style.css'), 'body{}')
  writeFileSync(path.join(root, 'assets', 'data.bin'), 'binary')
  writeFileSync(path.join(root, 'assets', 'space name.txt'), 'spaced')
  // Outside the root: what an escape would expose.
  mkdirSync(path.join(base, 'outside'))
  writeFileSync(path.join(base, 'outside', 'secret.txt'), 'outside-secret')
  writeFileSync(path.join(base, 'secret.txt'), 'outside-secret')
  symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(root, 'leak.txt'))
  symlinkSync(path.join(base, 'outside'), path.join(root, 'linked'))
  symlinkSync(path.join(root, 'assets', 'app.js'), path.join(root, 'alias.js'))
  handle = createAppProtocolHandler({ root, onRefused: (reason) => refused.push(reason) })
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const get = (url: string, method = 'GET') => handle(new Request(url, { method }))

describe('app:// asset path decoding', () => {
  it.each([
    ['/', ['index.html']],
    ['/index.html', ['index.html']],
    ['/assets/app.js', ['assets', 'app.js']],
    ['/assets/space%20name.txt', ['assets', 'space name.txt']],
  ])('maps %s to plain segments', (pathname, segments) => {
    expect(assetSegments(pathname)).toEqual(segments)
  })

  it.each([
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/%2e%2e/secret.txt',
    '/.%2e/secret.txt',
    '/..%2fsecret.txt',
    '/..%2Fsecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/%2fetc%2fpasswd',
    '//etc/passwd',
    '/assets//app.js',
    '/assets/',
    '/C:%5cWindows%5cwin.ini',
    '/c:/windows/win.ini',
    '/index.html%00.js',
    '/index%00.html',
    '/assets/%0aapp.js',
    '/.env',
    '/assets/.hidden.js',
    '/%E0%A4%A',
    'index.html',
    '',
  ])('refuses %j', (pathname) => {
    expect(assetSegments(pathname)).toBeUndefined()
  })

  it('checks containment by path, not by string prefix', () => {
    expect(isInside('/srv/renderer', '/srv/renderer/index.html')).toBe(true)
    expect(isInside('/srv/renderer', '/srv/renderer-evil/index.html')).toBe(false)
    expect(isInside('/srv/renderer', '/srv/renderer')).toBe(false)
    expect(isInside('/srv/renderer', '/srv/secret.txt')).toBe(false)
    expect(isInside('/srv/renderer', '/srv/renderer/..file')).toBe(true)
  })
})

describe('app:// protocol handler', () => {
  it('serves the entry document with the strict CSP and nosniff', async () => {
    const response = await get('app://cindl/index.html')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Cindl</title>')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-dns-prefetch-control')).toBe('off')
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe')
  })

  it('serves the root as index.html and assets with their MIME types', async () => {
    expect((await get('app://cindl/')).status).toBe(200)
    const script = await get('app://cindl/assets/app.js')
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const style = await get('app://cindl/assets/nested/style.css?v=1')
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await (await get('app://cindl/assets/space%20name.txt')).text()).toBe('spaced')
  })

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await get('app://cindl/index.html', 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await get('app://cindl/index.html', 'POST')).status).toBe(405)
  })

  it('refuses unknown file types and missing files', async () => {
    expect((await get('app://cindl/assets/data.bin')).status).toBe(404)
    expect((await get('app://cindl/missing.js')).status).toBe(404)
    expect((await get('app://cindl/assets')).status).toBe(404)
  })

  it('serves only the cindl host', async () => {
    expect((await get('app://evil/index.html')).status).toBe(404)
    // `Request` refuses credentials; Electron hands the handler the raw URL.
    // Assembled at runtime so no credential-bearing URL is committed.
    const withCredentials = {
      method: 'GET',
      url: ['app://user', 'pass@cindl/index.html'].join(':'),
    }
    expect((await handle(withCredentials as Request)).status).toBe(404)
    expect((await get('app://cindl:8080/index.html')).status).toBe(404)
  })

  it.each([
    'app://cindl/../secret.txt',
    'app://cindl/assets/../../secret.txt',
    'app://cindl/%2e%2e/secret.txt',
    'app://cindl/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    'app://cindl/..%2fsecret.txt',
    'app://cindl/..%2f..%2f..%2fetc%2fpasswd',
    'app://cindl/assets/..%5c..%5csecret.txt',
    'app://cindl/%2fetc%2fpasswd.txt',
    'app://cindl//etc/passwd.txt',
    'app://cindl/index.html%00.txt',
  ])('never serves anything outside the root for %s', async (url) => {
    const response = await get(url)
    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain('outside-secret')
  })

  it('refuses symlinks that resolve outside the root', async () => {
    const file = await get('app://cindl/leak.txt')
    expect(file.status).toBe(403)
    expect(await file.text()).toBe('')
    const directory = await get('app://cindl/linked/secret.txt')
    expect(directory.status).toBe(403)
    expect(refused).toContain('symlink-escape')
  })

  it('allows symlinks that stay inside the root', async () => {
    const response = await get('app://cindl/alias.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('export {}')
  })

  it('refuses everything when the root is missing', async () => {
    const missing = createAppProtocolHandler({ root: path.join(base, 'nope') })
    expect((await missing(new Request('app://cindl/index.html'))).status).toBe(404)
  })

  it('knows only a fixed set of MIME types', () => {
    expect(mimeType('a.woff2')).toBe('font/woff2')
    expect(mimeType('a.SVG')).toBe('image/svg+xml')
    expect(mimeType('a.exe')).toBeUndefined()
    expect(mimeType('Makefile')).toBeUndefined()
  })
})
