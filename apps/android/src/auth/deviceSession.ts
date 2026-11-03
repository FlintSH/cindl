import type { KeyValueStore } from '@cindl/client-core'
import { isCindlError } from '@cindl/contracts'
import type { NativeTokenSet } from '@cindl/hermes-adapter'
import type { SignInAttempt } from './signIn.ts'
import type { TokenVault } from './tokens.ts'

/**
 * The sign-in a real build can already hold while the Hermes connection
 * (createDirectClient, transport stream) is not part of the app: tokens in
 * the Keystore-backed vault, and the signed-in origin (not a secret) in the
 * key-value store so the next start knows which tokens to look for.
 */
export const SIGNED_IN_ORIGIN_KEY = 'signin.origin'

export const INTERRUPTED_NOTICE =
  'Cindl stopped waiting for the browser (the app was closed during sign-in). Nothing was saved. Start again.'
export const SIGN_IN_FAILED = 'Sign-in did not finish. Nothing was saved. Try again.'

export interface DeviceSessionDeps {
  keyValue: KeyValueStore
  tokens: TokenVault
  recoverSignIn: () => Promise<
    | { kind: 'none' }
    | { kind: 'resumable'; attempt: SignInAttempt }
    | { kind: 'interrupted'; origin: string | undefined }
  >
}

export type Startup =
  | { kind: 'resume'; attempt: SignInAttempt }
  | { kind: 'signed-in'; origin: string; notice?: string }
  | { kind: 'signed-out'; notice?: string }

/** On start: resume a surviving attempt, report an interrupted one, else read the saved sign-in. */
export async function startDeviceSession(deps: DeviceSessionDeps): Promise<Startup> {
  const recovery = await deps.recoverSignIn()
  if (recovery.kind === 'resumable') return { kind: 'resume', attempt: recovery.attempt }
  const notice = recovery.kind === 'interrupted' ? { notice: INTERRUPTED_NOTICE } : {}
  const origin = await deps.keyValue.get(SIGNED_IN_ORIGIN_KEY)
  if (origin !== undefined && (await deps.tokens.read(origin)) !== undefined)
    return { kind: 'signed-in', origin, ...notice }
  return { kind: 'signed-out', ...notice }
}

/** Keeps a finished sign-in: tokens first, so a stored origin always has tokens behind it. */
export async function keepSignIn(
  deps: Pick<DeviceSessionDeps, 'keyValue' | 'tokens'>,
  origin: string,
  tokens: NativeTokenSet,
): Promise<void> {
  await deps.tokens.write(origin, tokens)
  await deps.keyValue.set(SIGNED_IN_ORIGIN_KEY, origin)
}

/** Deletes this device's tokens only: Hermes v0.22.5 cannot revoke issued tokens. */
export async function signOutDevice(
  deps: Pick<DeviceSessionDeps, 'keyValue' | 'tokens'>,
  origin: string,
): Promise<void> {
  await deps.tokens.clear(origin)
  await deps.keyValue.delete(SIGNED_IN_ORIGIN_KEY)
}

export const signInFailure = (failure: unknown) =>
  isCindlError(failure) ? failure.message : SIGN_IN_FAILED
