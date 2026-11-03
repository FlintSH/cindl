import { ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme/theme.tsx'
import { Mark } from '../ui/Mark.tsx'
import { Txt } from '../ui/primitives.tsx'
import { DeviceSignIn } from './DeviceSignIn.tsx'

/**
 * Shown by a real (non-demo) build while it has no way to reach Hermes. It
 * says why, never substitutes demo data, and lets the owner sign in ahead of
 * the connection (DeviceSignIn).
 */
export function NotConnected() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.canvas }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        gap: theme.space[4],
        paddingTop: insets.top + theme.space[8],
        paddingBottom: insets.bottom + theme.space[8],
        paddingHorizontal: theme.space[6],
      }}
    >
      <Mark size={28} />
      <Text
        accessibilityRole="header"
        style={[theme.text.heading, { color: theme.colors.text }]}
      >
        Cindl is not connected
      </Text>
      <Txt variant="body">
        The direct connection to your Hermes server is not part of this build yet, so
        Cindl cannot show your conversations. It does not invent data in the meantime.
      </Txt>
      <DeviceSignIn />
      <View style={{ gap: theme.space[2] }}>
        <Txt tone="secondary">
          To explore the interface, install the labelled demo build, which shows synthetic
          data only.
        </Txt>
        <Txt tone="secondary">See the handbook: Clients, Android.</Txt>
      </View>
    </ScrollView>
  )
}
