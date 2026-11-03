import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { BackHandler } from 'react-native'
import { createBackDispatcher, type BackDispatcher } from './back.ts'
import {
  createNavStore,
  type NavAction,
  type NavState,
  type NavStore,
} from './navigation.ts'

interface NavContextValue {
  store: NavStore
  back: BackDispatcher
}

const NavContext = createContext<NavContextValue | null>(null)

/** Owns navigation state and the single Android back-button subscription. */
export function NavProvider({ children }: { children: ReactNode }) {
  const [value] = useState<NavContextValue>(() => {
    const store = createNavStore()
    const back = createBackDispatcher()
    // Registered first, so every overlay or editor registered later handles back before it.
    back.push(() => store.back())
    return { store, back }
  })
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () =>
      value.back.dispatch(),
    )
    return () => subscription.remove()
  }, [value])
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

function useNavContext(): NavContextValue {
  const value = useContext(NavContext)
  if (!value) throw new Error('Navigation hooks must be used inside <NavProvider>')
  return value
}

export function useNav(): NavState {
  const { store } = useNavContext()
  return useSyncExternalStore(store.subscribe, store.getState)
}

export function useNavigate(): (action: NavAction) => void {
  return useNavContext().store.dispatch
}

/**
 * Handles system back while `enabled`. Handlers registered later win, so
 * enable it at the moment the thing it closes appears (a sheet opening, an
 * editor gaining unsaved changes).
 */
export function useBackHandler(handler: () => boolean, enabled: boolean): void {
  const { back } = useNavContext()
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => {
    if (!enabled) return
    return back.push(() => latest.current())
  }, [back, enabled])
}

const ActiveContext = createContext(true)

/** Whether the surrounding destination is the one on screen (hidden ones stay mounted). */
export const DestinationActiveProvider = ActiveContext.Provider
export const useDestinationActive = () => useContext(ActiveContext)
