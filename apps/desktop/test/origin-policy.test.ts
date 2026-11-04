import { CindlError } from '@cindl/contracts'
import { describe, expect, it, vi } from 'vitest'
import { pinnedFetch } from '../src/main/platform/index.ts'
import {
  normalizeHermesOrigin,
  trustedStoredOrigin,
} from '../src/main/platform/origin-policy.ts'

describe('Hermes origin policy (R4)', () => {
  it.each([
    ['https://hermes.example.test', 'https://hermes.example.test'],
    ['https://hermes.example.test/', 'https://hermes.example.test'],
    ['HTTPS://Hermes.Example.Test:443', 'https://hermes.example.test'],
    ['https://hermes.example.test:9119', 'https://hermes.example.test:9119'],
    ['http://127.0.0.1:9119', 'http://127.0.0.1:9119'],
    ['http://[::1]:9119/', 'http://[::1]:9119'],
    ['https://127.0.0.1', 'https://127.0.0.1'],
    // The URL parser removes a lone dot segment; only the origin is kept.
    ['https://hermes.example.test/.', 'https://hermes.example.test'],
  ])('accepts %s as %s', (input, origin) => {
    expect(normalizeHermesOrigin(input)).toBe(origin)
  })

  it.each([
    ['plain http to another machine', 'http://hermes.example.test'],
    ['plain http to a LAN address', 'http://192.0.2.10:9119'],
    ['plain http to localhost by name', 'http://localhost:9119'],
    ['plain http to another loopback address', 'http://127.0.0.2:9119'],
    ['a trailing-dot host', 'https://hermes.example.test.'],
    ['port 0', 'https://hermes.example.test:0'],
    ['userinfo', 'https://owner:pw@hermes.example.test'],
    ['a user name', 'https://owner@hermes.example.test'],
    ['a path', 'https://hermes.example.test/hermes'],
    ['a double slash', 'https://hermes.example.test//'],
    ['a query', 'https://hermes.example.test/?next=x'],
    ['an empty query', 'https://hermes.example.test?'],
    ['a fragment', 'https://hermes.example.test/#x'],
    ['a websocket URL', 'wss://hermes.example.test'],
    ['a file URL', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['a bare host', 'hermes.example.test'],
    ['whitespace', ' https://hermes.example.test'],
    ['a newline', 'https://hermes.example.test\n'],
    ['a backslash', 'https://hermes.example.test\\@evil.example'],
    ['nothing', ''],
  ])('rejects %s (%j)', (_label, input) => {
    let error: unknown
    try {
      normalizeHermesOrigin(input)
    } catch (reason) {
      error = reason
    }
    expect(error).toBeInstanceOf(CindlError)
    expect((error as CindlError).code).toBe('invalid')
  })

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['https://hermes.example.test']])
      expect(() => normalizeHermesOrigin(value)).toThrow(CindlError)
  })

  it('trusts a stored origin only if it is still normalized and allowed', () => {
    expect(trustedStoredOrigin('https://hermes.example.test')).toBe(
      'https://hermes.example.test',
    )
    expect(trustedStoredOrigin('https://hermes.example.test/')).toBeUndefined()
    expect(trustedStoredOrigin('http://hermes.example.test')).toBeUndefined()
    expect(trustedStoredOrigin('https://owner:pw@hermes.example.test')).toBeUndefined()
    expect(trustedStoredOrigin(undefined)).toBeUndefined()
  })
})

describe('pinned fetch', () => {
  it('reaches only the confirmed Hermes origin', async () => {
    const pin: { origin?: string } = {}
    const inner = vi.fn(() => Promise.resolve(new Response('{}')))
    const fetch = pinnedFetch(inner, () => pin.origin)
    await expect(fetch('https://hermes.example.test/api/status', {})).rejects.toThrow(
      /outside the Hermes origin/,
    )
    pin.origin = 'https://hermes.example.test'
    await fetch('https://hermes.example.test/api/status', {})
    for (const url of [
      'https://evil.example.test/api/status',
      'http://hermes.example.test/api/status',
      'https://hermes.example.test:8443/api/status',
      'not a url',
    ])
      await expect(fetch(url, {})).rejects.toMatchObject({ code: 'invalid' })
    expect(inner).toHaveBeenCalledTimes(1)
  })
})
