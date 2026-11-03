import { createStore, type ClientState, type ClientStore } from '@cindl/client-core'
import type { CindlClientApi, LinkState } from '@cindl/contracts'
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  useRef,
} from 'react'

interface CindlContextValue {
  api: CindlClientApi
  store: ClientStore
}

const CindlContext = createContext<CindlContextValue | null>(null)

const bootLink = (): LinkState => ({
  phase: 'connecting',
  since: new Date().toISOString(),
  connectionEpoch: 0,
})

/** Connects one CindlClientApi to a store and exposes both to the tree. */
export function CindlProvider({
  api,
  children,
}: {
  api: CindlClientApi
  children: ReactNode
}) {
  const [store] = useState(() => createStore(bootLink()))
  useEffect(() => api.subscribe((event) => store.dispatch(event)), [api, store])
  return <CindlContext.Provider value={{ api, store }}>{children}</CindlContext.Provider>
}

function useCindlContext(): CindlContextValue {
  const value = useContext(CindlContext)
  if (!value) throw new Error('Cindl hooks must be used inside <CindlProvider>')
  return value
}

export function useCindlApi(): CindlClientApi {
  return useCindlContext().api
}

/**
 * Subscribe to a slice of client state. The snapshot is cached per store
 * state and selector, so a selector that builds a new array or object still
 * returns the same value until the state changes: React's
 * useSyncExternalStore requires that, or it re-renders forever.
 */
export function useCindlState<T>(selector: (state: ClientState) => T): T {
  const { store } = useCindlContext()
  const cache = useRef<{
    state: ClientState
    selector: (state: ClientState) => T
    value: T
  } | null>(null)
  const getSnapshot = () => {
    const state = store.getState()
    const cached = cache.current
    if (cached && cached.state === state && cached.selector === selector)
      return cached.value
    const value = selector(state)
    cache.current = { state, selector, value }
    return value
  }
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
