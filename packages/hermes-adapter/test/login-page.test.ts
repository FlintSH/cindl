import { describe, expect, it } from 'vitest'
import { isSafeNextPath, loginPagePath } from '../src/index.ts'

describe('isSafeNextPath (request_utils.py is_safe_next_path, and stricter)', () => {
  it('accepts a same-origin path outside the auth routes and /api', () => {
    for (const path of [
      '/',
      '/cindl/',
      '/cindl/c/1?view=a&b=2',
      '/apix',
      '/auth',
      '/authors',
    ])
      expect(isSafeNextPath(path), path).toBe(true)
  })

  it('refuses what Hermes refuses: other origins, its auth routes and /api', () => {
    for (const path of [
      '',
      'cindl/',
      'https://elsewhere.invalid/',
      '//elsewhere.invalid/',
      '/login',
      '/login?next=/',
      '/loginx',
      '/auth/logout',
      '/api',
      '/api/status',
      '/api/auth/me',
    ])
      expect(isSafeNextPath(path), path).toBe(false)
  })

  it('refuses what a browser would take to another origin, which Hermes lets through', () => {
    for (const path of [
      '/\\elsewhere.invalid/',
      '/\t/elsewhere.invalid/',
      '/\n/x',
      '/x\u007f',
    ])
      expect(isSafeNextPath(path), JSON.stringify(path)).toBe(false)
  })
})

describe('loginPagePath', () => {
  it('asks Hermes to come back to a safe path, escaping each % twice', () => {
    expect(loginPagePath()).toBe('/login')
    expect(loginPagePath('')).toBe('/login')
    expect(loginPagePath('/cindl/')).toBe('/login?next=%2Fcindl%2F')
    expect(loginPagePath('/c/a%20b')).toBe('/login?next=%2Fc%2Fa%25252520b')
  })

  it('leaves an unsafe path out, so Hermes lands on its root', () => {
    expect(loginPagePath('//elsewhere.invalid/')).toBe('/login')
    expect(loginPagePath('/\\elsewhere.invalid/')).toBe('/login')
    expect(loginPagePath('/api/status')).toBe('/login')
  })
})
