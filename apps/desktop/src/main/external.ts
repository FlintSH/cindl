/**
 * Links leave Cindl only through the system browser, and only as plain https
 * URLs. Everything else (javascript:, file:, data:, custom schemes, http,
 * credentials in the URL, ambiguous spellings) is refused, so agent output or
 * a compromised renderer cannot launch local handlers or smuggle secrets.
 */
export type ExternalUrlCheck = { ok: true; url: string } | { ok: false; reason: string }

export const MAX_EXTERNAL_URL_LENGTH = 2048

export function validateExternalUrl(input: unknown): ExternalUrlCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' }
  if (input.length === 0 || input.length > MAX_EXTERNAL_URL_LENGTH)
    return { ok: false, reason: 'length' }
  // Whitespace, control characters and backslashes make URLs ambiguous
  // (WHATWG parsing strips or rewrites them); refuse instead of guessing.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(input)) return { ok: false, reason: 'characters' }
  // Require the literal `https://` spelling: `https:host` also parses as https.
  if (!/^https:\/\//i.test(input)) return { ok: false, reason: 'scheme' }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'credentials' }
  if (url.hostname === '') return { ok: false, reason: 'host' }
  return { ok: true, url: url.href }
}

export interface ExternalOpener {
  /** Validates and opens `input`; never throws. */
  open(input: unknown): Promise<{ opened: boolean }>
}

/**
 * Wraps the platform opener (Electron `shell.openExternal`) with validation,
 * a user-gesture requirement and a small rate limit. The renderer is
 * untrusted: without a click or Enter/Space press that main saw arrive from
 * the operating system, it cannot open the browser (for example to carry data
 * out in a URL), and one gesture opens at most one link.
 */
export function createExternalOpener(options: {
  open: (url: string) => Promise<void>
  /** Consumes a recent trusted user gesture; absent means no gesture is needed. */
  consumeGesture?: () => boolean
  onRejected?: (reason: string) => void
  now?: () => number
  limit?: { count: number; windowMs: number }
}): ExternalOpener {
  const now = options.now ?? Date.now
  const { count, windowMs } = options.limit ?? { count: 5, windowMs: 10_000 }
  const recent: number[] = []
  return {
    async open(input) {
      const check = validateExternalUrl(input)
      if (!check.ok) {
        options.onRejected?.(check.reason)
        return { opened: false }
      }
      const time = now()
      while (recent.length && (recent[0] as number) <= time - windowMs) recent.shift()
      if (recent.length >= count) {
        options.onRejected?.('rate-limited')
        return { opened: false }
      }
      if (options.consumeGesture && !options.consumeGesture()) {
        options.onRejected?.('no-user-gesture')
        return { opened: false }
      }
      recent.push(time)
      try {
        await options.open(check.url)
        return { opened: true }
      } catch {
        options.onRejected?.('open-failed')
        return { opened: false }
      }
    },
  }
}
