import { useTool } from '@cindl/client-react'
import type { ToolStatus } from '@cindl/contracts'
import { useRef, useState } from 'react'
import { Pressable, Text, View, type HostInstance } from 'react-native'
import { notePress } from '../overlay/opener.ts'
import { useTheme } from '../theme/theme.tsx'
import { Ban, Check, ChevronRight, CircleAlert, Hand } from '../ui/icons.ts'
import { focusRing, Spinner } from '../ui/primitives.tsx'
import { duration } from './format.ts'

export const toolStatusLabel: Record<ToolStatus, string> = {
  generating: 'Preparing',
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
}

/** Only an actively executing step spins; a step blocked on the owner shows a still hand. */
export function ToolStatusIcon({
  status,
  blocked = false,
  size = 14,
}: {
  status: ToolStatus
  blocked?: boolean
  size?: number
}) {
  const { colors } = useTheme()
  if (blocked) return <Hand size={size} color={colors.accentText} strokeWidth={2} />
  if (status === 'complete')
    return <Check size={size} color={colors.success} strokeWidth={2} />
  if (status === 'error')
    return <CircleAlert size={size} color={colors.danger} strokeWidth={2} />
  if (status === 'cancelled')
    return <Ban size={size} color={colors.textTertiary} strokeWidth={2} />
  return <Spinner color={colors.accentText} size={size} />
}

/** One quiet line per tool step; selecting it opens redacted evidence in the margin. */
export function ToolRow({
  toolId,
  selected,
  blocked,
  onSelect,
}: {
  toolId: string
  selected: boolean
  /** The step is paused until the owner answers a request. */
  blocked: boolean
  onSelect: (toolId: string) => void
}) {
  const theme = useTheme()
  const tool = useTool(toolId)
  const [focused, setFocused] = useState(false)
  const self = useRef<HostInstance | null>(null)
  if (!tool) return null
  const state = blocked ? 'Waiting for you' : toolStatusLabel[tool.status]
  const meta = blocked
    ? 'Waiting for you'
    : tool.status === 'complete'
      ? duration(tool.startedAt, tool.endedAt)
      : (tool.progress ?? toolStatusLabel[tool.status])
  return (
    <Pressable
      ref={self}
      accessibilityRole="button"
      accessibilityLabel={`${tool.title}. ${state}${
        meta && meta !== state ? `, ${meta}` : ''
      }. Show details.`}
      accessibilityState={{ selected }}
      onPress={() => {
        // The working margin this opens gives focus back to this row.
        notePress(self)
        onSelect(tool.id)
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={{ color: theme.colors.selection }}
      style={[
        {
          minHeight: theme.layout.touchTarget,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          paddingHorizontal: theme.space[2],
          paddingVertical: theme.space[1],
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: selected ? theme.colors.border : 'transparent',
          backgroundColor: selected ? theme.colors.surface : 'transparent',
        },
        focused ? focusRing(theme) : null,
      ]}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: theme.radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.surfaceSunken,
        }}
      >
        <ToolStatusIcon status={tool.status} blocked={blocked} />
      </View>
      <Text
        numberOfLines={1}
        style={[theme.text.ui, { flex: 1, color: theme.colors.textSecondary }]}
      >
        {tool.title}
      </Text>
      {meta ? (
        <Text style={[theme.text.label, { color: theme.colors.textTertiary }]}>
          {meta}
        </Text>
      ) : null}
      <ChevronRight size={14} color={theme.colors.textTertiary} strokeWidth={1.75} />
    </Pressable>
  )
}
