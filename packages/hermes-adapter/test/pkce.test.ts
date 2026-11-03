import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  base64Url,
  buildAuthorizeUrl,
  canonicalLoopbackRedirect,
  createPkcePair,
  createState,
  parseCallback,
  webCryptoProvider,
} from '../src/pkce.ts'

const crypto = webCryptoProvider()

describe('PKCE pair', () => {
  it('produces an RFC 7636 S256 challenge for a 43+ character verifier', async () => {
    const pair = await createPkcePair(crypto)
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    const expected = base64Url(
      createHash('sha256').update(pair.verifier, 'ascii').digest(),
    )
    expect(pair.challenge).toBe(expected)
    expect(pair.method).toBe('S256')
  })

  it('matches the RFC 7636 appendix B test vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const digest = await crypto.sha256(new TextEncoder().encode(verifier))
    expect(base64Url(digest)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('never repeats verifiers or states', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      seen.add((await createPkcePair(crypto)).verifier)
      seen.add(createState(crypto))
    }
    expect(seen.size).toBe(100)
  })
})

describe('loopback redirect validation mirrors Hermes v0.22.5', () => {
  it.each([
    ['http://127.0.0.1:53682/callback', 'http://127.0.0.1:53682/callback'],
    ['http://127.0.0.1:53682', 'http://127.0.0.1:53682/'],
    ['http://[::1]:8080/cb?x=1', 'http://[::1]:8080/cb?x=1'],
  ])('accepts %s', (raw, canonical) => {
    expect(canonicalLoopbackRedirect(raw)).toBe(canonical)
  })

  it.each([
    'http://localhost:53682/callback',
    'https://127.0.0.1:53682/callback',
    'cindl://callback',
    'http://127.0.0.1.example.com/callback',
    'http://user:pass@127.0.0.1:1/callback',
    'http://127.0.0.1:1/callback#frag',
    'http://127.0.0.1:01/callback',
    'http://127.0.0.1:70000/callback',
    'http://127.0.0.1\\@evil.example/cb',
    'http://127.0.0.1:1/ca llback',
    'http://10.0.2.2:5000/callback',
    '',
  ])('rejects %j', (raw) => {
    expect(() => canonicalLoopbackRedirect(raw)).toThrow()
  })
})

describe('authorize URL and callback', () => {
  it('builds the exact v0.22.5 authorize query', async () => {
    const pkce = await createPkcePair(crypto)
    const url = new URL(
      buildAuthorizeUrl({
        origin: 'https://hermes.example.test',
        redirectUri: 'http://127.0.0.1:4100/callback',
        pkce,
        state: 'state-1',
      }),
    )
    expect(url.pathname).toBe('/auth/native/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      redirect_uri: 'http://127.0.0.1:4100/callback',
      state: 'state-1',
    })
  })

  it('accepts a code only when state matches', () => {
    expect(parseCallback('/callback?code=abc&state=s1', 's1')).toEqual({
      ok: true,
      code: 'abc',
    })
    expect(parseCallback('/callback?code=abc&state=s2', 's1')).toEqual({
      ok: false,
      reason: 'state-mismatch',
    })
    expect(parseCallback('/callback?state=s1', 's1')).toEqual({
      ok: false,
      reason: 'missing-code',
    })
    expect(parseCallback('/callback?code=abc', 's1')).toMatchObject({
      ok: false,
      reason: 'state-mismatch',
    })
  })
})

describe('callback state', () => {
  it('rejects every callback when the expected state is empty', () => {
    expect(parseCallback('/callback?code=abc&state=', '')).toEqual({
      ok: false,
      reason: 'state-mismatch',
    })
    expect(parseCallback('/callback?code=abc', '')).toMatchObject({ ok: false })
  })
})
