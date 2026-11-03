import { promises as fs } from 'node:fs'
import path from 'node:path'
import { APP_HOST, APP_SCHEME } from '../shared/origin.ts'

export { APP_ENTRY_URL, APP_HOST, APP_ORIGIN, APP_SCHEME } from '../shared/origin.ts'

/**
 * The renderer (the production apps/web build) is served from a privileged
 * custom scheme instead of file://. The handler maps `app://cindl/<path>` onto
 * one directory and refuses anything that could escape it: dot segments
 * (plain or percent-encoded), encoded separators, NUL and control characters,
 * absolute paths, drive letters and symlinks that resolve outside the root.
 * Only known file types are served, always with `nosniff` and a strict CSP.
 */
/** Privileges for `protocol.registerSchemesAsPrivileged` (before app ready). */
export const APP_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  codeCache: true,
} as const

/**
 * Stricter than the web build's meta policy: the renderer reaches Hermes only
 * through the preload bridge, so it may not connect anywhere at all.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'payment=()',
  'display-capture=()',
  'midi=()',
  'clipboard-read=()',
  'idle-detection=()',
  'local-fonts=()',
].join(', ')

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
  // The CSP does not cover DNS prefetching (<link rel=dns-prefetch>).
  'X-DNS-Prefetch-Control': 'off',
  'Cache-Control': 'no-cache',
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

/** MIME type for a file name, or undefined for anything Cindl does not serve. */
export function mimeType(name: string): string | undefined {
  return MIME_TYPES[path.extname(name).toLowerCase()]
}

const MAX_SEGMENTS = 16
const MAX_SEGMENT_LENGTH = 255
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_SEGMENT = /[\u0000-\u001f\u007f/\\:]/

/**
 * Decodes a URL pathname into safe path segments, or returns undefined.
 * Each segment is percent-decoded exactly once and must be a plain file or
 * directory name: no `.`/`..`, no leading dot, no separators, no NUL or
 * control characters, no `:` (drive letters, alternate data streams).
 */
export function assetSegments(pathname: string): string[] | undefined {
  if (!pathname.startsWith('/')) return undefined
  if (pathname === '/') return ['index.html']
  const parts = pathname.slice(1).split('/')
  if (parts.length > MAX_SEGMENTS) return undefined
  const segments: string[] = []
  for (const part of parts) {
    let name: string
    try {
      name = decodeURIComponent(part)
    } catch {
      return undefined
    }
    if (
      name === '' ||
      name.startsWith('.') ||
      name.endsWith(' ') ||
      name.length > MAX_SEGMENT_LENGTH ||
      FORBIDDEN_IN_SEGMENT.test(name)
    )
      return undefined
    segments.push(name)
  }
  return segments
}

/** True when `target` is strictly inside `root` (both absolute, normalized). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function respond(status: number, body: BodyInit | null, type: string) {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': type },
  })
}

const refuse = (status: number) => respond(status, null, 'text/plain; charset=utf-8')

export type AppProtocolHandler = (request: Request) => Promise<Response>

/**
 * Builds the `protocol.handle('app', …)` handler for one renderer directory.
 * `onRefused` receives a short reason for diagnostics (never file contents).
 */
export function createAppProtocolHandler(options: {
  root: string
  onRefused?: (reason: string, url: string) => void
}): AppProtocolHandler {
  let realRoot: Promise<string> | undefined
  const refused = (status: number, reason: string, url: string) => {
    options.onRefused?.(reason, url)
    return refuse(status)
  }
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return refused(405, 'method', request.url)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return refused(400, 'unparseable', request.url)
    }
    if (
      url.protocol !== `${APP_SCHEME}:` ||
      url.host !== APP_HOST ||
      url.username !== '' ||
      url.password !== ''
    )
      return refused(404, 'origin', request.url)
    const segments = assetSegments(url.pathname)
    if (!segments) return refused(400, 'path', request.url)
    const type = mimeType(segments.at(-1) as string)
    if (!type) return refused(404, 'type', request.url)

    realRoot ??= fs.realpath(options.root)
    let root: string
    try {
      root = await realRoot
    } catch {
      realRoot = undefined
      return refused(404, 'root-missing', request.url)
    }
    const candidate = path.join(root, ...segments)
    if (!isInside(root, candidate)) return refused(400, 'outside-root', request.url)
    let real: string
    try {
      real = await fs.realpath(candidate)
    } catch {
      return refused(404, 'not-found', request.url)
    }
    // A symlink (file or any parent directory) that resolves outside the root.
    if (!isInside(root, real)) return refused(403, 'symlink-escape', request.url)
    try {
      const stat = await fs.stat(real)
      if (!stat.isFile()) return refused(404, 'not-a-file', request.url)
      const body = request.method === 'HEAD' ? null : await fs.readFile(real)
      return respond(200, body, type)
    } catch {
      return refused(404, 'unreadable', request.url)
    }
  }
}
