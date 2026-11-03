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
