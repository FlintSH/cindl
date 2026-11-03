import { describe, expect, it, vi } from 'vitest'
import {
  createExternalOpener,
  MAX_EXTERNAL_URL_LENGTH,
  validateExternalUrl,
} from '../src/main/external.ts'

describe('openExternal URL validation', () => {
  it.each([
    ['https://example.test/', 'https://example.test/'],
    ['https://example.test/docs?q=kiln#glaze', 'https://example.test/docs?q=kiln#glaze'],
    ['HTTPS://EXAMPLE.TEST/A', 'https://example.test/A'],
    ['https://bücher.example.test/', 'https://xn--bcher-kva.example.test/'],
    ['https://example.test:8443/path', 'https://example.test:8443/path'],
  ])('accepts %s', (input, normalized) => {
    expect(validateExternalUrl(input)).toEqual({ ok: true, url: normalized })
  })

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['JaVaScRiPt:alert(1)', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['data:text/html,<script>alert(1)</script>', 'scheme'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'scheme'],
    ['http://example.test/', 'scheme'],
    ['vscode://file/etc/passwd', 'scheme'],
    ['cindl://callback', 'scheme'],
    ['ms-settings:', 'scheme'],
    ['smb://example.test/share', 'scheme'],
    ['https:example.test', 'scheme'],
    ['https:/example.test', 'scheme'],
    ['//example.test/', 'scheme'],
    ['https://user:pass@example.test/', 'credentials'],
    ['https://user@example.test/', 'credentials'],
    ['https://example.test\\@evil.example/', 'characters'],
    [' https://example.test/', 'characters'],
    ['https://example.test/\nSet-Cookie:x', 'characters'],
    ['https://example.test/\u0000', 'characters'],
    ['https://exa mple.test/', 'characters'],
    ['https://', 'unparseable'],
    ['', 'length'],
    [`https://example.test/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`, 'length'],
  ])('rejects %j (%s)', (input, reason) => {
    expect(validateExternalUrl(input)).toEqual({ ok: false, reason })
  })

  it.each([
    undefined,
    null,
    42,
    {},
    ['https://example.test/'],
    new URL('https://example.test/'),
  ])('rejects the non-string %j', (input) => {
    expect(validateExternalUrl(input)).toEqual({ ok: false, reason: 'not-a-string' })
  })
})

describe('external opener', () => {
  it('opens only validated URLs, normalized', async () => {
    const open = vi.fn(() => Promise.resolve())
    const rejected: string[] = []
    const opener = createExternalOpener({
      open,
      onRejected: (reason) => rejected.push(reason),
    })
    expect(await opener.open('javascript:alert(1)')).toEqual({ opened: false })
    expect(await opener.open('HTTPS://Example.test/x')).toEqual({ opened: true })
    expect(open.mock.calls).toEqual([['https://example.test/x']])
    expect(rejected).toEqual(['scheme'])
  })

  it('rate limits bursts and recovers after the window', async () => {
    let time = 0
    const open = vi.fn(() => Promise.resolve())
    const opener = createExternalOpener({
      open,
      now: () => time,
      limit: { count: 2, windowMs: 1000 },
    })
    expect((await opener.open('https://example.test/1')).opened).toBe(true)
    expect((await opener.open('https://example.test/2')).opened).toBe(true)
    expect((await opener.open('https://example.test/3')).opened).toBe(false)
    time = 1000
    expect((await opener.open('https://example.test/4')).opened).toBe(true)
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('opens nothing without a fresh user gesture, and one link per gesture', async () => {
    let gesture = false
    const open = vi.fn(() => Promise.resolve())
    const rejected: string[] = []
    const opener = createExternalOpener({
      open,
      consumeGesture: () => {
        const had = gesture
        gesture = false
        return had
      },
      onRejected: (reason) => rejected.push(reason),
    })
    expect(await opener.open('https://example.test/exfil?d=secret')).toEqual({
      opened: false,
    })
    gesture = true
    expect(await opener.open('https://example.test/docs')).toEqual({ opened: true })
    expect(await opener.open('https://example.test/second')).toEqual({ opened: false })
    // An invalid URL does not use up the gesture.
    gesture = true
    expect(await opener.open('javascript:alert(1)')).toEqual({ opened: false })
    expect(gesture).toBe(true)
    expect(open.mock.calls).toEqual([['https://example.test/docs']])
    expect(rejected).toEqual(['no-user-gesture', 'no-user-gesture', 'scheme'])
  })

  it('reports a failing system opener instead of throwing', async () => {
    const opener = createExternalOpener({
      open: () => Promise.reject(new Error('no browser')),
    })
    expect(await opener.open('https://example.test/')).toEqual({ opened: false })
  })
})
