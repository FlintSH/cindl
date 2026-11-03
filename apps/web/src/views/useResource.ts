import { isCindlError } from '@cindl/contracts'
import { useEffect, useEffectEvent, useState } from 'react'

interface ResourceState<T> {
  key: string
  token: number
  data?: T
  error?: string
}

/**
 * Loads one Cindl read operation for `key`. State only changes in async
 * callbacks, results for a stale key are ignored, and `reload` re-runs it.
 * A failed reload keeps what was last read for the same key beside the
 * error, so an open editor and its draft survive it.
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
      (data) => alive && setState({ key, token, data }),
      (err: unknown) => {
        if (!alive) return
        const error = isCindlError(err) ? err.message : fallbackError
        setState((previous) =>
          previous?.key === key && previous.data !== undefined
            ? { key, token, data: previous.data, error }
            : { key, token, error },
        )
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
      setState((previous) =>
        previous === undefined || previous.key === key ? { key, token, data } : previous,
      ),
  }
}
