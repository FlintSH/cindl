import {
  createContext,
  Fragment,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

interface PortalApi {
  mount(key: string, node: ReactNode): void
  unmount(key: string): void
}

const PortalContext = createContext<PortalApi | null>(null)
const OverlayCountContext = createContext(0)

/**
 * Renders sheets and dialogs above the whole app (tab bar included) in the
 * main window. They stay in-tree rather than in a native Modal so keyboard
 * insets, edge-to-edge padding and the back order work the same everywhere.
 */
export function PortalHost({ children }: { children: ReactNode }) {
  const [nodes, setNodes] = useState<ReadonlyArray<readonly [string, ReactNode]>>([])
  const api = useMemo<PortalApi>(
    () => ({
      mount: (key, node) =>
        setNodes((current) => {
          const index = current.findIndex(([k]) => k === key)
          if (index < 0) return [...current, [key, node] as const]
          const next = [...current]
          next[index] = [key, node] as const
          return next
        }),
      unmount: (key) => setNodes((current) => current.filter(([k]) => k !== key)),
    }),
    [],
  )
  return (
    <PortalContext.Provider value={api}>
      <OverlayCountContext.Provider value={nodes.length}>
        {children}
        {nodes.map(([key, node]) => (
          <Fragment key={key}>{node}</Fragment>
        ))}
      </OverlayCountContext.Provider>
    </PortalContext.Provider>
  )
}

export function Portal({ children }: { children: ReactNode }) {
  const host = useContext(PortalContext)
  const key = useId()
  useLayoutEffect(() => {
    if (!host) throw new Error('<Portal> must be rendered inside <PortalHost>')
    host.mount(key, children)
  })
  useLayoutEffect(() => () => host?.unmount(key), [host, key])
  return null
}

/** Number of open overlays; the app hides its content from TalkBack while one is open. */
export function useOverlayCount(): number {
  return useContext(OverlayCountContext)
}
