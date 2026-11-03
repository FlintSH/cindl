import { useLink, useOpenRequests } from '@cindl/client-react'
import { useEffect, useState, type ReactNode } from 'react'
import { StatusBar, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AgentView } from '../agent/AgentView.tsx'
import { LibraryView } from '../library/LibraryView.tsx'
import { destinations, type Destination } from '../nav/navigation.ts'
import { DestinationActiveProvider, useNav, useNavigate } from '../nav/NavProvider.tsx'
import { useOverlayCount } from '../overlay/Portal.tsx'
import { TalkView } from '../talk/TalkView.tsx'
import { useTheme } from '../theme/theme.tsx'
import { forgetDrafts, sessionEnded } from '../views/drafts.ts'
import { Layer } from '../views/Layer.tsx'
import { WorkView } from '../work/WorkView.tsx'
import { BottomNav } from './BottomNav.tsx'
import { DemoBanner } from './DemoBanner.tsx'
import { useKeyboardHeight } from './keyboard.tsx'
import { Notices } from './Notices.tsx'
import { SignIn } from './SignIn.tsx'

function screen(destination: Destination): ReactNode {
  switch (destination) {
    case 'talk':
      return <TalkView />
    case 'work':
      return <WorkView />
    case 'library':
      return <LibraryView />
    case 'agent':
      return <AgentView />
  }
}

/**
 * The app frame: demo banner, the four destinations and bottom navigation.
 * A destination mounts on its first visit and then stays mounted (hidden),
 * so returning to it restores the exact scroll position. While the keyboard
 * is up the bottom navigation steps aside and the content ends at the
 * keyboard's top edge.
 */
export function AppShell() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const link = useLink()
  const open = useOpenRequests()
  const nav = useNav()
  const navigate = useNavigate()
  const keyboard = useKeyboardHeight()
  const overlays = useOverlayCount()
  const [visited, setVisited] = useState<ReadonlySet<Destination>>(
    () => new Set(['talk']),
  )
  if (!visited.has(nav.destination)) setVisited(new Set([...visited, nav.destination]))
  // Nothing typed on this device outlives the session, however it ended: the
  // sign-out button, or Hermes refusing the session (web parity). Kept drafts
  // go too, so none comes back after another sign-in, to this Hermes or another.
  const ended = sessionEnded(link)
  useEffect(() => {
    if (ended) forgetDrafts()
  }, [ended])
  // From a sign-in until the client is online, the sign-in screen stays: while the
  // browser is open the link says "connecting", and a failed attempt shows its error.
  const [signingIn, setSigningIn] = useState(false)
  if (signingIn && link.phase === 'online') setSigningIn(false)
  // Real builds without a session sign in first; the demo never needs to.
  const signedOut =
    !link.demo &&
    (link.phase === 'unconfigured' || link.phase === 'signed-out' || signingIn)
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      <StatusBar barStyle={theme.name === 'dark' ? 'light-content' : 'dark-content'} />
      <View
        style={{ flex: 1 }}
        importantForAccessibility={overlays > 0 ? 'no-hide-descendants' : 'auto'}
      >
        <View
          style={{
            paddingTop: insets.top,
            backgroundColor: link.demo ? theme.colors.warningSubtle : theme.colors.canvas,
          }}
        >
          {link.demo ? <DemoBanner /> : null}
        </View>
        <Notices />
        {signedOut ? (
          <View style={{ flex: 1, paddingLeft: insets.left, paddingRight: insets.right }}>
            <SignIn onAttempt={() => setSigningIn(true)} />
          </View>
        ) : (
          <View style={{ flex: 1, paddingLeft: insets.left, paddingRight: insets.right }}>
            {destinations
              .filter((destination) => visited.has(destination))
              .map((destination) => (
                <Layer key={destination} visible={destination === nav.destination}>
                  <DestinationActiveProvider value={destination === nav.destination}>
                    {screen(destination)}
                  </DestinationActiveProvider>
                </Layer>
              ))}
          </View>
        )}
        {keyboard > 0 ? (
          <View style={{ height: keyboard }} />
        ) : signedOut ? (
          <View style={{ height: insets.bottom }} />
        ) : (
          <BottomNav
            current={nav.destination}
            workCount={open.length}
            onSelect={(destination) => navigate({ type: 'go', destination })}
          />
        )}
      </View>
    </View>
  )
}
