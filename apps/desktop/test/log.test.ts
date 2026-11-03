import { describe, expect, it } from 'vitest'
import { createLogger, formatLogLine, parseLogLevel } from '../src/main/log.ts'

const at = new Date('2026-06-02T08:00:00.000Z')
const SECRETS = [
  'abcdefghijklmnop1234',
  'dXNlcjpwYXNzd29yZA',
  'COOKIEsecret123456',
  'SETCOOKIEsecret123456',
  'TICKETsecret123456',
  'CODEsecret123456',
  'VERIFIERsecret123456',
  'ACCESSsecret123456',
  'REFRESHsecret123456',
  'DIGESTsecret123456',
]

const line = (message: string, detail?: unknown) =>
  formatLogLine('info', message, detail, at)

function expectClean(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret)
}

describe('main-process log redaction (R6)', () => {
  it.each([
    'Authorization: Bearer abcdefghijklmnop1234',
    'authorization: Basic dXNlcjpwYXNzd29yZA==',
    'Authorization: Digest DIGESTsecret123456',
    'Proxy-Authorization: Bearer abcdefghijklmnop1234',
    'Cookie: hermes_session=COOKIEsecret123456; theme=dark',
    'Set-Cookie: hermes_session=SETCOOKIEsecret123456; Path=/; HttpOnly',
    'set-cookie=hermes_session=SETCOOKIEsecret123456',
    'Sec-WebSocket-Protocol: hermes-gateway-v1, hermes-gateway-ticket.TICKETsecret123456',
    'wss://hermes.example.test/api/ws?ticket=TICKETsecret123456',
    'GET http://127.0.0.1:41234/callback?code=CODEsecret123456&state=x',
    '{"Set-Cookie":"hermes_session=SETCOOKIEsecret123456","ok":true}',
    'https://owner:REFRESHsecret123456@hermes.example.test/',
  ])('masks %j in messages', (message) => {
    expectClean(line(message))
  })

  it('masks headers, token sets and errors in details', () => {
    const text = line('request failed', {
      headers: {
        Authorization: 'Bearer abcdefghijklmnop1234',
        Cookie: 'hermes_session=COOKIEsecret123456',
        'Set-Cookie': ['hermes_session=SETCOOKIEsecret123456; HttpOnly'],
        'Sec-WebSocket-Protocol':
          'hermes-gateway-v1, hermes-gateway-ticket.TICKETsecret123456',
      },
      tokens: {
        access_token: 'ACCESSsecret123456',
        refresh_token: 'REFRESHsecret123456',
        token_type: 'bearer',
        expires_at: 1_800_000_000,
      },
      body: { code: 'CODEsecret123456', code_verifier: 'VERIFIERsecret123456' },
      note: 'retrying with Cookie: hermes_session=COOKIEsecret123456',
    })
    expectClean(text)
    expect(text).toContain('"token_type":"bearer"')
    expect(text).toContain('"expires_at":1800000000')
  })

  it('logs errors by name, message and code only, redacted', () => {
    const error = Object.assign(
      new Error('upgrade failed for hermes-gateway-ticket.TICKETsecret123456'),
      { code: 'ECONNRESET', cause: { token: 'ACCESSsecret123456' } },
    )
    const text = line('socket error', error)
    expectClean(text)
    expect(text).toContain('"errorCode":"ECONNRESET"')
    expect(text).toContain('upgrade failed')
  })

  it('keeps ordinary diagnostics readable', () => {
    expect(line('Refused an app:// request', { reason: 'symlink-escape' })).toBe(
      '2026-06-02T08:00:00.000Z INFO Refused an app:// request {"reason":"symlink-escape"}',
    )
  })

  it('filters by level', () => {
    const lines: string[] = []
    const log = createLogger({
      level: parseLogLevel('warn'),
      write: (l) => lines.push(l),
    })
    log.debug('debug')
    log.info('info')
    log.warn('warn')
    log.error('error')
    expect(lines.map((l) => l.split(' ')[1])).toEqual(['WARN', 'ERROR'])
    expect(parseLogLevel(undefined)).toBe('info')
    expect(parseLogLevel('verbose')).toBe('info')
  })
})
