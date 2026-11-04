import { CindlError } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  asCindlError,
  hermesDidNotAnswer,
  httpError,
  httpStatusOf,
  offlineError,
  protocolError,
  timeoutError,
} from '../src/index.ts'

describe('hermesDidNotAnswer', () => {
  it('holds for no network, a timeout, a 5xx and rate limiting', () => {
    expect(hermesDidNotAnswer(offlineError('GET /api/status: network error'))).toBe(true)
    expect(hermesDidNotAnswer(timeoutError('GET /api/status: no response'))).toBe(true)
    for (const status of [500, 502, 503, 504, 429, 408])
      expect(
        hermesDidNotAnswer(httpError(status, {}, 'GET /api/auth/me')),
        `${status}`,
      ).toBe(true)
  })

  it("does not hold for Hermes's answers, whatever their code", () => {
    for (const status of [400, 401, 403, 404, 409, 422])
      expect(
        hermesDidNotAnswer(httpError(status, {}, 'GET /api/auth/me')),
        `${status}`,
      ).toBe(false)
    expect(hermesDidNotAnswer(protocolError('GET /api/status: not JSON'))).toBe(false)
  })

  it('does not hold for a failure on this device, even one coded like a 5xx', () => {
    // asCindlError calls any exception internal, the code a 500 gets too.
    const device = asCindlError(new Error('keystore locked (fixture)'), 'auth.me')
    expect(device.code).toBe('internal')
    expect(hermesDidNotAnswer(device)).toBe(false)
    expect(hermesDidNotAnswer(new CindlError('offline', 'Superseded.'))).toBe(false)
    expect(hermesDidNotAnswer(new Error('not a CindlError (fixture)'))).toBe(false)
  })
})

describe('httpStatusOf', () => {
  it('gives the status an HTTP answer came with, and nothing for anything else', () => {
    expect(httpStatusOf(httpError(400, {}, 'POST /auth/native/token'))).toBe(400)
    expect(httpStatusOf(httpError(503, {}, 'GET /api/status'))).toBe(503)
    expect(httpStatusOf(new CindlError('invalid', 'Refused (fixture).'))).toBeUndefined()
    expect(httpStatusOf(offlineError('GET /api/status: network error'))).toBeUndefined()
  })
})
