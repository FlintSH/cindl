// @vitest-environment node
// The loopback static server for fronts that cannot set headers
// (apps/web/serve/cindl-serve.py), driven as the operator runs it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
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

/**
 * Raw bytes in, then everything the server sends until it closes the
 * connection, or `null` if it is still open after `waitMs`.
 */
function raw(port: number, data: string, waitMs = 5000) {
  return new Promise<{ text: string; ms: number } | null>((resolve, reject) => {
    const started = Date.now()
    const chunks: Buffer[] = []
    const socket = connect(port, '127.0.0.1', () => {
      if (data) socket.write(Buffer.from(data, 'latin1'))
    })
    const giveUp = setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, waitMs)
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => {
      clearTimeout(giveUp)
      socket.end()
      resolve({
        text: Buffer.concat(chunks).toString('latin1'),
        ms: Date.now() - started,
      })
    })
    socket.on('error', (error) => {
      clearTimeout(giveUp)
      reject(error)
    })
  })
}

/** The status line and headers of a raw answer, names in lower case. */
function parsed(text: string) {
  const [head = '', body = ''] = text.split('\r\n\r\n')
  const [status = '', ...lines] = head.split('\r\n')
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { status, headers, body }
}

let server: ChildProcess
let port = 0
let log = ''

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
  server = spawn(
    'python3',
    [script, '--root', root, '--port', '0', '--idle-timeout', '1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  server.stderr!.setEncoding('utf8')
  server.stderr!.on('data', (chunk: string) => (log += chunk))
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

  it.each([
    [
      'an unknown method',
      'PROPFIND /cindl/<b>quoted</b> HTTP/1.1\r\nHost: x\r\n\r\n',
      501,
    ],
    ['a request line of four words', 'GET /cindl/ <b>quoted</b> HTTP/1.1\r\n\r\n', 400],
    // Sent without the line's end: the server answers once it has read too much.
    ['a request line too long', `GET /${'q'.repeat(65_540)}`, 414],
    ['a header too long', `GET /cindl/ HTTP/1.1\r\nX-Quoted: ${'q'.repeat(65_540)}`, 431],
    [
      'too many headers',
      `GET /cindl/ HTTP/1.1\r\n${'X-Quoted: q\r\n'.repeat(101)}\r\n`,
      431,
    ],
  ])(
    'answers %s with its own headers, in plain text that quotes nothing',
    async (_, request, code) => {
      const answer = await raw(port, request)
      const { status, headers, body } = parsed(answer!.text)
      expect(status).toMatch(new RegExp(`^HTTP/1\\.0 ${code} [A-Za-z -]+$`))
      expect(headers).toMatchObject({
        'content-security-policy': "frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-cache',
      })
      // The body is the status's own phrase, nothing from the request.
      expect(body).toBe(`${status.split(' ').slice(2).join(' ')}\n`)
      expect(answer!.text).not.toMatch(/quoted|PROPFIND|qqqq/i)
    },
  )

  it('answers a malformed HEAD without a body', async () => {
    const answer = await raw(
      port,
      `HEAD /cindl/ HTTP/1.1\r\n${'X-Quoted: q\r\n'.repeat(101)}\r\n`,
    )
    const { status, headers, body } = parsed(answer!.text)
    expect(status).toMatch(/^HTTP\/1\.0 431 /)
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(body).toBe('')
  })

  it.each([
    ['no version', 'GET /cindl/\r\n\r\n'],
    ['no version and another method', 'POST /cindl/\r\n\r\n'],
    ['an unsupported version', 'GET /cindl/ HTTP/2.0\r\n\r\n'],
    ['a malformed version', 'GET /cindl/ <b>quoted</b>\r\n\r\n'],
  ])(
    'sends nothing back to a request with %s, since no answer could carry the headers',
    async (_, request) => {
      // Closed (not left open), with nothing sent.
      const answer = await raw(port, request)
      expect(answer?.text).toBe('')
      await expect.poll(() => log).toContain('not answered: no HTTP version')
    },
  )

  it('writes control bytes to its log escaped, and a backslash doubled', async () => {
    const answer = await raw(
      port,
      'GET /cindl/\x1b[31mred\x07\\x07 HTTP/1.1\r\nHost: x\r\n\r\n',
    )
    expect(parsed(answer!.text).status).toBe('HTTP/1.0 404 Not Found')
    await expect
      .poll(() => log)
      .toContain('"GET /cindl/\\x1b[31mred\\x07\\\\x07 HTTP/1.1" 404')
    const control = [...log].filter((character) => {
      const code = character.codePointAt(0)!
      return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code < 0xa0)
    })
    expect(control).toEqual([])
  })

  it(
    'closes a connection that sends nothing, or stops partway through its request, once idle for the timeout',
    { timeout: 15_000 },
    async () => {
      // This server runs with --idle-timeout 1.
      const answers = await Promise.all([raw(port, ''), raw(port, 'GET /cindl/')])
      for (const answer of answers) {
        expect(answer?.text).toBe('')
        expect(answer!.ms).toBeGreaterThanOrEqual(900)
        expect(answer!.ms).toBeLessThan(4000)
      }
      expect((await get(port, '/cindl/')).status).toBe(200)
    },
  )

  it('refuses an idle timeout outside (0, 300] seconds, and a mount that is not a plain path', () => {
    const run = (args: string[]) =>
      spawnSync('python3', [script, '--root', root, '--port', '0', ...args], {
        encoding: 'utf8',
        timeout: 10_000,
      })
    for (const seconds of ['0', '-1', 'nan', 'inf', '301']) {
      const refused = run(['--idle-timeout', seconds])
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('--idle-timeout must be')
    }
    for (const mount of [
      '/cindl\n',
      '/',
      '//cindl',
      '/./cindl',
      '/../cindl',
      '/.cindl-bare',
      'cindl',
      '/cin dl',
      '/cindl/%2e',
    ]) {
      const refused = run(['--mount', mount])
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('the mount must be a path')
    }
  })

  it(
    'serves a nested mount, with its own bare redirect',
    { timeout: 15_000 },
    async () => {
      const nested = spawn(
        'python3',
        [script, '--root', root, '--port', '0', '--mount', '/apps/cindl/'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      try {
        const at = await new Promise<number>((resolve, reject) => {
          nested.stdout.setEncoding('utf8')
          nested.stdout.on('data', (line: string) => {
            const found = /http:\/\/127\.0\.0\.1:(\d+) for \/apps\/cindl\//.exec(line)
            if (found) resolve(Number(found[1]))
          })
          nested.on('exit', (code) => reject(new Error(`cindl-serve exited ${code}`)))
        })
        const bare = await get(at, '/apps/cindl')
        expect(bare.status).toBe(301)
        expect(bare.headers.location).toBe('/apps/cindl/')
        expect((await get(at, '/apps/cindl/')).body).toBe(INDEX)
      } finally {
        nested.kill()
      }
    },
  )
})
