import { useCallback, useRef, useState, type ReactNode, type Ref } from 'react'
import { ScrollView, Text, View, type HostInstance } from 'react-native'
import { FocusFallback } from '../overlay/opener.ts'
import { useTheme } from '../theme/theme.tsx'
import { focusRing, Press, SectionTitle, Txt } from '../ui/primitives.tsx'

/** Scrolling page for Work, Library and Agent: title, lead, then sections. */
export function Page({
  title,
  lead,
  tabs,
  children,
}: {
  title: string
  lead: string
  tabs?: ReactNode
  children: ReactNode
}) {
  const theme = useTheme()
  const heading = useRef<HostInstance | null>(null)
  const focusHeading = useCallback(() => heading.current, [])
  return (
    // An overlay closed after what opened it went gives focus to the page's heading.
    <FocusFallback value={focusHeading}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: theme.space[6],
          paddingHorizontal: theme.space[4],
          paddingTop: theme.space[5],
          paddingBottom: theme.space[10],
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: theme.space[1] }}>
          <Text
            ref={heading}
            accessibilityRole="header"
            style={[theme.text.heading, { color: theme.colors.text }]}
          >
            {title}
          </Text>
          <Txt tone="secondary">{lead}</Txt>
        </View>
        {tabs}
        {children}
      </ScrollView>
    </FocusFallback>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()
  const heading = useRef<HostInstance | null>(null)
  const focusHeading = useCallback(() => heading.current, [])
  return (
    <View style={{ gap: theme.space[3] }}>
      <SectionTitle ref={heading}>{title}</SectionTitle>
      {/* An overlay closed after what opened it here went gives focus to this heading. */}
      <FocusFallback value={focusHeading}>{children}</FocusFallback>
    </View>
  )
}

/**
 * Tabs (Library's and Agent's sections, the working margin's tools). Each is a
 * touch target (48dp on Android) named by its visible text. They scroll
 * sideways, or with `wrap` go onto another line, so none is out of view at a
 * large font (the working margin). `selectedRef` is the selected tab's view,
 * for focus.
 */
export function Tabs<T extends string>({
  label,
  items,
  current,
  onSelect,
  wrap = false,
  selectedRef,
}: {
  label: string
  items: ReadonlyArray<{ id: T; label: string }>
  current: T
  onSelect: (id: T) => void
  wrap?: boolean
  selectedRef?: Ref<HostInstance>
}) {
  const theme = useTheme()
  const tabs = items.map((item) => (
    <Tab
      key={item.id}
      label={item.label}
      selected={item.id === current}
      onPress={() => onSelect(item.id)}
      {...(item.id === current && selectedRef ? { ref: selectedRef } : {})}
    />
  ))
  return wrap ? (
    <View
      accessibilityLabel={label}
      accessibilityRole="tablist"
      style={{ flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1 }}
    >
      {tabs}
    </View>
  ) : (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={label}
      accessibilityRole="tablist"
      style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: theme.colors.border }}
    >
      {tabs}
    </ScrollView>
  )
}

function Tab({
  ref,
  label,
  selected,
  onPress,
}: {
  ref?: Ref<HostInstance>
  label: string
  selected: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <Press
      {...(ref ? { ref } : {})}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={{ color: theme.colors.selection }}
      style={[
        {
          minHeight: theme.layout.touchTarget,
          justifyContent: 'center',
          paddingHorizontal: theme.space[3],
          borderBottomWidth: 2,
          borderBottomColor: selected ? theme.colors.accent : 'transparent',
        },
        focused ? focusRing(theme) : null,
      ]}
    >
      <Text
        style={[
          theme.text.ui,
          {
            fontFamily: theme.fonts.medium,
            color: selected ? theme.colors.text : theme.colors.textSecondary,
          },
        ]}
      >
        {label}
      </Text>
    </Press>
  )
}
