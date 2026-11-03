// TEST-ONLY: one loopback origin like the approved deployment (Cindl at
// `/cindl/` on its Hermes's origin). It serves the real production web build
// (`dist`) under `/cindl/` and forwards every other request, WebSocket
// upgrades included, unchanged to the fake Hermes. So the browser talks to
// "Hermes" on the page's own origin, with Hermes's cookie, its Host/Origin
// checks and its tickets as they are. Synthetic data only; never deployed.
import { createReadStream, existsSync, statSync } from 'node:fs'
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
}

export interface SameOrigin {
  /** `http://127.0.0.1:<port>`: the page's origin, and "Hermes's". */
  readonly origin: string
  close(): Promise<void>
}

/** Serves `dist` at `/cindl/`; everything else goes to `hermesPort`. */
export async function startSameOrigin(options: {
  dist: string
  hermesPort: number
}): Promise<SameOrigin> {
  const { dist, hermesPort } = options
  const serveStatic = (res: ServerResponse, path: string) => {
    const relative = path === '/cindl/' ? 'index.html' : path.slice('/cindl/'.length)
    const file = normalize(join(dist, relative))
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('Not Found')
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // What the deployment must send for Cindl's pages (a meta tag cannot).
      'content-security-policy': "frame-ancestors 'none'",
      'cache-control': 'no-store',
    })
    createReadStream(file).pipe(res)
  }
  const forward = (req: IncomingMessage, res: ServerResponse) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: hermesPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://same-origin.invalid').pathname
    if (path === '/cindl') {
      res.writeHead(301, { location: '/cindl/' }).end()
      return
    }
    if (path.startsWith('/cindl/')) serveStatic(res, path)
    else forward(req, res)
  })
  // WebSocket upgrades go to Hermes byte for byte, headers (Host, Origin,
  // cookies, the ticket subprotocol) included.
  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const upstream = connect(hermesPort, '127.0.0.1', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
