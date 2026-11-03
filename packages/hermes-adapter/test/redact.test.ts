import { describe, expect, it } from 'vitest'
import { redactText, redactUrl, redactValue } from '../src/redact.ts'

// Synthetic secret-shaped strings are assembled at runtime so secret scanners
// do not flag this file; none of them is a real credential.
const fake = (...parts: string[]) => parts.join('')

describe('redaction', () => {
  it.each([
    ['protocols: hermes-gateway-v1, hermes-gateway-ticket.AbC123_-xyz', 'AbC123_-xyz'],
    ['GET /api/display/ws?ticket=t0p-s3cret&x=1', 't0p-s3cret'],
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    [fake('key sk', '-ant-', 'REDACTME', 'example000000000000'), 'REDACTME'],
    [fake('token gh', 'p_', 'a'.repeat(28)), 'p_aaaa'],
    ['{"password": "hunter2-correct-horse"}', 'hunter2'],
    ['api_key=live_1234567890abcdef', 'live_1234'],
    ['https://alice:pw123@example.test/path', 'pw123'],
    [
      fake(
        '-----BEGIN ',
        'PRIVATE KEY-----\n',
        'SYNTHETICbodyNOTaKEY',
        '\n-----END ',
        'PRIVATE KEY-----',
      ),
      'SYNTHETICbody',
    ],
    [
      fake(
        'jwt ',
        'eyJ',
        'hbGciOiJub25lIn0',
        '.',
        'eyJ',
        'zdWIiOiJzeW50aGV0aWMifQ',
        '.',
        'c3ludGhldGljc2ln',
      ),
      'zdWIiOiJzeW50aGV0aWMifQ',
    ],
  ])('removes the secret from %j', (input, secret) => {
    const output = redactText(input)
    expect(output).not.toContain(secret)
    expect(output).toContain('[redacted]')
  })

  it('leaves ordinary prose alone', () => {
    const prose = 'Booked the venue for 12 people on Friday; the token budget is fine.'
    expect(redactText(prose)).toBe(prose)
  })

  it('masks sensitive keys at any depth', () => {
    expect(
      redactValue({
        access_token: 'a',
        nested: [{ refresh_token: 'b', ticket: 'c', label: 'ok' }],
        Authorization: 'Bearer x',
      }),
    ).toEqual({
      access_token: '[redacted]',
      nested: [{ refresh_token: '[redacted]', ticket: '[redacted]', label: 'ok' }],
      Authorization: '[redacted]',
    })
  })

  it('strips query values and userinfo from URLs', () => {
    expect(
      redactUrl('https://u:p@hermes.example.test/api/ws?ticket=abc&profile=default'),
    ).toBe('https://hermes.example.test/api/ws?ticket=[redacted]&profile=[redacted]')
  })
})

describe('redaction of Hermes credentials (review R6)', () => {
  it.each([
    [
      'display.observe reply',
      '{"ticket":"DISPLAYTICKET0001","path":"/api/display/ws"}',
      'DISPLAYTICKET0001',
    ],
    ['token field', '{"token": "OPAQUESESSIONTOKEN"}', 'OPAQUESESSIONTOKEN'],
    [
      'code_verifier field',
      '{"code_verifier":"VERIFIERVALUE0123456789"}',
      'VERIFIERVALUE0123456789',
    ],
    ['oauth code string', '{"code":"ONETIMECODE42","state":"x"}', 'ONETIMECODE42'],
    [
      'lowercase bearer header',
      'authorization: bearer lowercasetoken123',
      'lowercasetoken123',
    ],
    [
      'session cookie',
      'Cookie: theme=dark; hermes_session_at=COOKIEACCESS77; other=1',
      'COOKIEACCESS77',
    ],
    ['refresh cookie', 'set hermes_session_rt=COOKIEREFRESH88 ok', 'COOKIEREFRESH88'],
    ['prefixed cookie', '__Host-hermes_session_at=HOSTPREFIXED99;', 'HOSTPREFIXED99'],
    [
      'set-cookie header',
      'Set-Cookie: hermes_session_pkce=PKCECOOKIE11; HttpOnly',
      'PKCECOOKIE11',
    ],
    [
      'display ticket query',
      'wss://hermes.example.test/api/display/ws?display_ticket=QUERYTICKET22',
      'QUERYTICKET22',
    ],
    ['viewer id', '{"viewer_id":"VIEWERCAPABILITY33"}', 'VIEWERCAPABILITY33'],
    ['x-api-key header', 'x-api-key: APIKEYVALUE44', 'APIKEYVALUE44'],
  ])('removes the secret from a %s', (_label, input, secret) => {
    const output = redactText(input)
    expect(output).not.toContain(secret)
    expect(output).toContain('[redacted]')
  })

  it('masks opaque, dot-less session tokens by key at any depth', () => {
    expect(
      redactValue({
        token: 'opaque',
        session_token: 'opaque',
        'x-api-key': 'opaque',
        ws_ticket: 'opaque',
        display_ticket: 'opaque',
        cookie: 'opaque',
        'set-cookie': ['opaque'],
        viewer_id: 'opaque',
        nested: { code_verifier: 'opaque', code: 'opaque' },
      }),
    ).toEqual({
      token: '[redacted]',
      session_token: '[redacted]',
      'x-api-key': '[redacted]',
      ws_ticket: '[redacted]',
      display_ticket: '[redacted]',
      cookie: '[redacted]',
      'set-cookie': '[redacted]',
      viewer_id: '[redacted]',
      nested: { code_verifier: '[redacted]', code: '[redacted]' },
    })
  })

  it('keeps JSON-RPC and HTTP numeric codes visible', () => {
    const frame = {
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32601, message: 'unknown method' },
    }
    expect(redactValue(frame)).toEqual(frame)
    expect(redactText(JSON.stringify(frame))).toBe(JSON.stringify(frame))
    expect(redactValue({ status: 401, code: 4000 })).toEqual({ status: 401, code: 4000 })
  })

  it('strips URL fragments', () => {
    expect(redactUrl('https://hermes.example.test/cb?code=abc#access_token=frag')).toBe(
      'https://hermes.example.test/cb?code=[redacted]',
    )
    expect(redactUrl('not a url #access_token=frag')).toBe('not a url ')
  })
})
