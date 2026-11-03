import { isCindlError } from '@cindl/contracts'
import { useEffect, useEffectEvent, useState } from 'react'

export interface ResourceState<T> {
  key: string
  token: number
  data?: T
  error?: string
}

/** A replacement applies only while the state still belongs to its key. */
export function replaceForKey<T>(
  previous: ResourceState<T> | undefined,
  next: ResourceState<T>,
): ResourceState<T> | undefined {
  return previous === undefined || previous.key === next.key ? next : previous
}

/**
 * A failed reload keeps what was last read for the same key beside the error,
 * so an open editor and its draft survive it.
 */
export function failedRead<T>(
  previous: ResourceState<T> | undefined,
  failed: { key: string; token: number; error: string },
): ResourceState<T> {
  return previous?.key === failed.key && previous.data !== undefined
    ? { ...failed, data: previous.data }
    : failed
}

/**
 * Loads one Cindl read operation for `key` (same contract as the web hook).
 * State only changes in async callbacks, results for a stale key are ignored,
 * and `reload` re-runs it. Mount it only after the capability check passes:
 * gated reads are never fetched early.
 */
export function useResource<T>(
  load: () => Promise<T>,
  key: string,
  fallbackError: string,
) {
  const [token, setToken] = useState(0)
  const [state, setState] = useState<ResourceState<T>>()
  const run = useEffectEvent(load)
  useEffect(() => {
    let alive = true
    run().then(
      (data) => {
        if (alive) setState({ key, token, data })
      },
      (error: unknown) => {
        if (!alive) return
        const message = isCindlError(error) ? error.message : fallbackError
        setState((previous) => failedRead(previous, { key, token, error: message }))
      },
    )
    return () => {
      alive = false
    }
  }, [key, token, fallbackError])
  const current = state?.key === key ? state : undefined
  return {
    data: current?.data,
    error: current?.error,
    loading: !current || current.token !== token,
    reload: () => setToken((value) => value + 1),
    // Only for the key it was given: a late save for another key (the owner
    // moved on) must not replace what is loaded now.
    replace: (data: T) =>
      setState((previous) => replaceForKey(previous, { key, token, data })),
  }
}
