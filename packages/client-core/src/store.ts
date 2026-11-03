import type { CindlEvent, LinkState } from '@cindl/contracts'
import { initialState, reduce, type ClientState } from './state.ts'

/** Property signatures: every member is safe to pass around unbound. */
export interface ClientStore {
  getState: () => ClientState
  dispatch: (event: CindlEvent) => void
  subscribe: (listener: () => void) => () => void
}

/** Minimal external store (works with React's useSyncExternalStore on web and Android). */
export function createStore(link: LinkState): ClientStore {
  let state = initialState(link)
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    dispatch(event) {
      const next = reduce(state, event)
      if (next === state) return
      state = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
