// Serves the built handbook on 127.0.0.1 only. VitePress 1.6.4's own
// `vitepress preview` ignores --host and listens on every interface, which
// breaks the rule that local servers bind loopback, so the handbook uses this.
// Usage: node .vitepress/preview.mjs [--port 4174]   (DOCS_BASE as for the build)
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, sep } from 'node:path'
import { parseArgs } from 'node:util'

const dist = join(import.meta.dirname, 'dist')
const base = process.env.DOCS_BASE || '/'
const { values } = parseArgs({ options: { port: { type: 'string', default: '4174' } } })
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
}

if (!existsSync(join(dist, 'index.html'))) {
  process.stderr.write('No build found. Run: pnpm --dir docs/handbook build\n')
  process.exit(1)
}

/** The file for a request path, or null. Never resolves outside dist. */
function fileFor(pathname) {
  if (!pathname.startsWith(base)) return null
  let relative
  try {
    relative = decodeURIComponent(pathname.slice(base.length))
  } catch {
    return null
  }
  const file = join(dist, relative)
  if (file !== dist && !file.startsWith(`${dist}${sep}`)) return null
  return (
    [file, join(file, 'index.html'), `${file}.html`].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  )
}

createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return
  }
  const file = fileFor(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
  const target = file ?? join(dist, '404.html')
  // Files can disappear while a rebuild replaces dist; answer instead of crashing.
  const stream = createReadStream(target)
  stream.on('error', () => {
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'text/plain' })
    response.end('The handbook build is being replaced; reload in a moment.\n')
  })
  stream.on('open', () => {
    response.writeHead(file ? 200 : 404, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') {
      stream.destroy()
      response.end()
    } else stream.pipe(response)
  })
}).listen(Number(values.port), '127.0.0.1', () => {
  process.stdout.write(`Handbook preview: http://127.0.0.1:${values.port}${base}\n`)
})
