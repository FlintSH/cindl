import { requireOptionalNativeModule } from 'expo'

/** Status of a sign-in attempt in this process. "unknown" after process death. */
export type LoopbackStatus = 'listening' | 'received' | 'ended' | 'unknown'

/**
 * The Kotlin loopback listener (android/src/main/java/dev/fl1nt/cindl/loopback).
 * It binds 127.0.0.1 on an ephemeral port, accepts one `GET /callback` whose
 * `state` matches, answers the browser with a static page and closes.
 */
export interface CindlLoopbackNative {
  start(attemptId: string, timeoutMillis: number): Promise<{ port: number }>
  /** False when the attempt is not (or no longer) listening in this process. */
  arm(attemptId: string, expectedState: string): boolean
  /** The callback's path and query. Rejects on timeout, cancel or an unknown attempt. */
  awaitCallback(attemptId: string): Promise<string>
  status(attemptId: string): LoopbackStatus
  cancel(attemptId: string): void
}

/** Null when the native module is not linked into this build. */
export const loopbackNative =
  requireOptionalNativeModule<CindlLoopbackNative>('CindlLoopback')
