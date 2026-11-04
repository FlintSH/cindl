import { useState } from 'react'
import { Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Destination } from '../nav/navigation.ts'
import { useTheme } from '../theme/theme.tsx'
import {
  Activity,
  Library,
  MessageSquareText,
  UserRound,
  type LucideIcon,
} from '../ui/icons.ts'
import { focusRing, Press } from '../ui/primitives.tsx'

const items: ReadonlyArray<{ id: Destination; label: string; icon: LucideIcon }> = [
  { id: 'talk', label: 'Talk', icon: MessageSquareText },
  { id: 'work', label: 'Work', icon: Activity },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'agent', label: 'Agent', icon: UserRound },
]

/** Bottom navigation for the four destinations (labels match the web navigation). */
export function BottomNav({
  current,
  workCount,
  onSelect,
}: {
  current: Destination
  workCount: number
  onSelect: (destination: Destination) => void
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View
      collapsable={false}
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.canvas,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {items.map((item) => (
        <NavItem
          key={item.id}
          label={item.label}
          icon={item.icon}
          selected={current === item.id}
          count={item.id === 'work' ? workCount : 0}
          onPress={() => onSelect(item.id)}
        />
      ))}
    </View>
  )
}

function NavItem({
  label,
  icon: Icon,
  selected,
  count,
  onPress,
}: {
  label: string
  icon: LucideIcon
  selected: boolean
  count: number
  onPress: () => void
}) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)
  const color = selected ? theme.colors.text : theme.colors.textSecondary
  return (
    <Press
      accessibilityRole="tab"
      accessibilityLabel={count > 0 ? `${label}, ${count} waiting on you` : label}
      accessibilityState={{ selected }}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={{ color: theme.colors.selection, borderless: true }}
      style={[
        {
          flex: 1,
          minHeight: 56,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space[0.5],
          paddingVertical: theme.space[1.5],
        },
        focused ? focusRing(theme) : null,
      ]}
    >
      {selected ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: '30%',
            right: '30%',
            height: 3,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.accent,
          }}
        />
      ) : null}
      <View>
        <Icon size={20} color={color} strokeWidth={1.75} />
        {count > 0 ? (
          <View
            style={{
              position: 'absolute',
              top: -6,
              left: 12,
              minWidth: 17,
              height: 17,
              paddingHorizontal: 4,
              borderRadius: theme.radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.accent,
            }}
          >
            <Text
              maxFontSizeMultiplier={1.4}
              style={[
                theme.text.caption,
                {
                  fontSize: 11,
                  lineHeight: 14,
                  fontFamily: theme.fonts.semibold,
                  color: theme.colors.onAccent,
                },
              ]}
            >
              {count > 9 ? '9+' : String(count)}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        style={[
          theme.text.caption,
          { color, fontFamily: selected ? theme.fonts.semibold : theme.fonts.medium },
        ]}
      >
        {label}
      </Text>
    </Press>
  )
}
