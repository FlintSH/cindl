// @vitest-environment node
// The loopback static server for fronts that cannot set headers
// (apps/web/serve/cindl-serve.py), driven as the operator runs it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../serve/cindl-serve.py', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'cindl-serve-'))
const root = join(work, 'dist')
const INDEX = '<!doctype html><title>Cindl (fixture)</title>'

/** A raw request: the path goes out byte for byte, never normalised by a client. */
function get(port: number, path: string, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string>; body: string }>(
    (resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body,
          }),
        )
      })
      req.on('error', reject)
      req.end()
    },
  )
}

let server: ChildProcess
let port = 0

beforeAll(async () => {
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(join(root, 'empty'))
  mkdirSync(join(work, 'outside'))
  writeFileSync(join(root, 'index.html'), INDEX)
  writeFileSync(join(root, 'favicon.svg'), '<svg/>')
  writeFileSync(join(root, 'assets', 'index-0lhCoXes.js'), 'export {}')
  writeFileSync(join(root, 'assets', 'index-0lhCoXes.js.map'), '{}')
  writeFileSync(join(root, 'assets', 'index-Dky7H3HT.css'), 'body{}')
  writeFileSync(join(root, 'assets', 'Font-tWV223Ma.woff2'), 'woff2')
  writeFileSync(join(root, 'notes.txt'), 'not part of a build')
  writeFileSync(join(work, 'secret.html'), 'outside the root')
  writeFileSync(join(work, 'outside', 'x.js'), 'outside the root')
  symlinkSync(join(work, 'secret.html'), join(root, 'leak.html'))
  symlinkSync(join(work, 'outside'), join(root, 'linked'))
  server = spawn('python3', [script, '--root', root, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  port = await new Promise<number>((resolve, reject) => {
    server.stdout!.setEncoding('utf8')
    server.stdout!.on('data', (line: string) => {
      const found = /http:\/\/127\.0\.0\.1:(\d+)/.exec(line)
      if (found) resolve(Number(found[1]))
    })
    server.on('exit', (code) => reject(new Error(`cindl-serve exited ${code}`)))
  })
})

afterAll(() => {
  server?.kill()
  rmSync(work, { recursive: true, force: true })
})

const headersOf = (headers: Record<string, string>) => ({
  csp: headers['content-security-policy'],
  sniff: headers['x-content-type-options'],
})

describe('cindl-serve', () => {
  it('redirects the bare mount path, and the stripped-front sentinel, to the mount with a slash', async () => {
    for (const path of ['/cindl', '/.cindl-bare']) {
      const res = await get(port, path)
      expect(res.status).toBe(301)
      expect(res.headers.location).toBe('/cindl/')
      expect(headersOf(res.headers)).toEqual({
        csp: "frame-ancestors 'none'",
        sniff: 'nosniff',
      })
    }
  })

  it('serves the page and its assets whether the front passes the mount through or strips it', async () => {
    for (const prefix of ['/cindl', '']) {
      const page = await get(port, `${prefix}/`)
      expect(page.status).toBe(200)
      expect(page.body).toBe(INDEX)
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(page.headers['cache-control']).toBe('no-cache')
      expect(headersOf(page.headers)).toEqual({
        csp: "frame-ancestors 'none'",
        sniff: 'nosniff',
      })
      const script = await get(port, `${prefix}/assets/index-0lhCoXes.js?v=1`)
      expect(script.status).toBe(200)
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
      expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    }
  })

  it.each([
    ['/cindl/assets/index-Dky7H3HT.css', 'text/css; charset=utf-8', 'immutable'],
    ['/cindl/assets/Font-tWV223Ma.woff2', 'font/woff2', 'immutable'],
    [
      '/cindl/assets/index-0lhCoXes.js.map',
      'application/json; charset=utf-8',
      'immutable',
    ],
    ['/cindl/favicon.svg', 'image/svg+xml', 'no-cache'],
    ['/cindl/index.html', 'text/html; charset=utf-8', 'no-cache'],
  ])('sends %s as %s, cached %s', async (path, type, cache) => {
    const res = await get(port, path)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe(type)
    expect(res.headers['cache-control']).toContain(cache)
  })

  it.each([
    '/cindl/../secret.html',
    '/../secret.html',
    '/cindl/%2e%2e/secret.html',
    '/cindl/assets/..%2F..%2Fsecret.html',
    '/cindl\\..\\secret.html',
    '//secret.html',
    '/cindl/./index.html',
    '/cindl/leak.html',
    '/cindl/linked/x.js',
    '/cindl/assets/',
    '/cindl/empty/',
    '/cindl/notes.txt',
    '/api/status',
  ])('never serves %s', async (path) => {
    const res = await get(port, path)
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('outside the root')
    expect(headersOf(res.headers)).toEqual({
      csp: "frame-ancestors 'none'",
      sniff: 'nosniff',
    })
  })

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await get(port, '/cindl/', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(INDEX.length))
    expect(head.body).toBe('')
    const post = await get(port, '/cindl/', 'POST')
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
  })

  it('listens on loopback only, and refuses a root without index.html', () => {
    for (const host of ['0.0.0.0', '192.0.2.10', 'localhost']) {
      const run = spawnSync(
        'python3',
        [script, '--root', root, '--port', '0', '--host', host],
        {
          encoding: 'utf8',
          timeout: 10_000,
        },
      )
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('loopback')
    }
    const run = spawnSync(
      'python3',
      [script, '--root', join(work, 'outside'), '--port', '0'],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('no index.html')
  })
})
