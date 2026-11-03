import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { View, type HostInstance, type StyleProp, type ViewStyle } from 'react-native'
import { blockKeyboardFocus } from './keyboardFocus.ts'

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

/**
 * What overlays cover: while any dialog or sheet is open, hidden from TalkBack
 * with everything in it, and closed to a hardware keyboard's focus, so only the
 * overlay can be reached (its scrim takes every touch). The overlays
 * themselves render beside it, in the PortalHost.
 */
export function BehindOverlays({
  children,
  style,
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const open = useOverlayCount() > 0
  const self = useRef<HostInstance | null>(null)
  const blocked = useRef(false)
  useEffect(() => {
    if (blocked.current === open) return
    blocked.current = open
    blockKeyboardFocus(self.current, open)
  }, [open])
  return (
    <View
      ref={self}
      collapsable={false}
      style={style}
      importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
    >
      {children}
    </View>
  )
}
