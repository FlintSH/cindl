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
      (err: unknown) =>
        alive &&
        setState({ key, token, error: isCindlError(err) ? err.message : fallbackError }),
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
    replace: (data: T) => setState({ key, token, data }),
  }
}
