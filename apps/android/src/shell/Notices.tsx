import { useCindlState } from '@cindl/client-react'
import { useState } from 'react'
import { View } from 'react-native'
import { useTheme } from '../theme/theme.tsx'
import { X } from '../ui/icons.ts'
import { Button, Txt } from '../ui/primitives.tsx'

/**
 * Client notices (an interrupted sign-in, tokens kept in memory only), above
 * the screen until dismissed (web parity: apps/web/src/shell/Notices.tsx).
 */
export function Notices() {
  const theme = useTheme()
  const notices = useCindlState((state) => state.notices)
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  const visible = notices.filter((notice) => !dismissed.has(notice.id)).slice(-3)
  if (!visible.length) return null
  return (
    <View
      collapsable={false}
      accessibilityLiveRegion="polite"
      style={{
        gap: theme.space[2],
        paddingHorizontal: theme.space[4],
        paddingTop: theme.space[2],
      }}
    >
      {visible.map((notice) => (
        <View
          key={notice.id}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space[2],
            paddingLeft: theme.space[3],
            borderWidth: 1,
            borderRadius: theme.radius.md,
            borderColor:
              notice.level === 'error' ? theme.colors.danger : theme.colors.border,
            backgroundColor:
              notice.level === 'info' ? theme.colors.surface : theme.colors.warningSubtle,
          }}
        >
          <Txt style={{ flex: 1, paddingVertical: theme.space[2] }}>{notice.message}</Txt>
          <Button
            label="Dismiss notice"
            icon={X}
            iconOnly
            variant="quiet"
            onPress={() => setDismissed((current) => new Set([...current, notice.id]))}
          />
        </View>
      ))}
    </View>
  )
}
