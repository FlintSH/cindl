/// <reference types="node" />
import { CindlError } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import {
  INTERRUPTED_NOTICE,
  keepSignIn,
  SIGN_IN_FAILED,
  SIGNED_IN_ORIGIN_KEY,
  signInFailure,
  signOutDevice,
  startDeviceSession,
  type DeviceSessionDeps,
} from '../src/auth/deviceSession.ts'
import type { SignInAttempt } from '../src/auth/signIn.ts'
import { createTokenVault } from '../src/auth/tokens.ts'

const ORIGIN = 'https://hermes.example.test'
const TOKENS = {
  access_token: 'at',
  refresh_token: 'rt',
  token_type: 'bearer',
  expires_at: 1_900_000_000,
  provider: 'basic',
  user_id: 'owner-fixture',
}

function memory() {
  const data = new Map<string, string>()
  return {
    data,
    store: {
      available: true,
      get: (key: string) => Promise.resolve(data.get(key)),
      set: (key: string, value: string) => Promise.resolve(void data.set(key, value)),
      delete: (key: string) => Promise.resolve(void data.delete(key)),
    },
  }
}

function deps(
  recovery: Awaited<ReturnType<DeviceSessionDeps['recoverSignIn']>> = { kind: 'none' },
) {
  const keyValue = memory()
  const secrets = memory()
  return {
    keyValue,
    secrets,
    deps: {
      keyValue: keyValue.store,
      tokens: createTokenVault(secrets.store),
      recoverSignIn: () => Promise.resolve(recovery),
    } satisfies DeviceSessionDeps,
  }
}

describe('device sign-in session (real builds before the connection lands)', () => {
  it('starts signed out, keeps a finished sign-in and finds it on the next start', async () => {
    const { deps: session, keyValue } = deps()
    expect(await startDeviceSession(session)).toEqual({ kind: 'signed-out' })
    await keepSignIn(session, ORIGIN, TOKENS)
    expect(keyValue.data.get(SIGNED_IN_ORIGIN_KEY)).toBe(ORIGIN)
    expect(await startDeviceSession(session)).toEqual({
      kind: 'signed-in',
      origin: ORIGIN,
    })
  })

  it('never reports signed in without tokens behind the stored origin', async () => {
    const { deps: session, keyValue } = deps()
    keyValue.data.set(SIGNED_IN_ORIGIN_KEY, ORIGIN)
    expect(await startDeviceSession(session)).toEqual({ kind: 'signed-out' })
  })

  it('resumes a surviving attempt and reports an interrupted one', async () => {
    const attempt = { id: 'a1', origin: ORIGIN } as SignInAttempt
    expect(await startDeviceSession(deps({ kind: 'resumable', attempt }).deps)).toEqual({
      kind: 'resume',
      attempt,
    })
    expect(
      await startDeviceSession(deps({ kind: 'interrupted', origin: ORIGIN }).deps),
    ).toEqual({
      kind: 'signed-out',
      notice: INTERRUPTED_NOTICE,
    })
    expect(INTERRUPTED_NOTICE).toMatch(/^Cindl stopped waiting for the browser/)
  })

  it('signs out by deleting this device tokens and the stored origin', async () => {
    const { deps: session, keyValue, secrets } = deps()
    await keepSignIn(session, ORIGIN, TOKENS)
    await signOutDevice(session, ORIGIN)
    expect(keyValue.data.size).toBe(0)
    expect(secrets.data.size).toBe(0)
    expect(await startDeviceSession(session)).toEqual({ kind: 'signed-out' })
  })

  it('shows the specific sign-in error, or a generic one that says nothing was saved', () => {
    expect(
      signInFailure(
        new CindlError(
          'timeout',
          'The browser did not return to Cindl in time. Nothing was saved.',
        ),
      ),
    ).toBe('The browser did not return to Cindl in time. Nothing was saved.')
    expect(signInFailure(new Error('boom'))).toBe(SIGN_IN_FAILED)
  })
})
