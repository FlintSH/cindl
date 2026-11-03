import { SYNTHETIC_DEMO_NOTICE } from '@cindl/contracts'
import { View } from 'react-native'
import { useTheme } from '../theme/theme.tsx'
import { TriangleAlert } from '../ui/icons.ts'
import { Txt } from '../ui/primitives.tsx'

/**
 * Always shown when the link reports `demo: true`; never dismissible. The
 * copy is the contract's label (ADR 0011), kept in every build.
 */
export function DemoBanner() {
  const theme = useTheme()
  return (
    <View
      accessible
      accessibilityLabel={SYNTHETIC_DEMO_NOTICE}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[2],
        paddingVertical: theme.space[1],
        paddingHorizontal: theme.space[3],
        backgroundColor: theme.colors.warningSubtle,
      }}
    >
      <TriangleAlert size={14} color={theme.colors.warning} strokeWidth={2} />
      <Txt
        variant="label"
        tone="warning"
        weight="medium"
        style={{ flexShrink: 1, textAlign: 'center' }}
      >
        {SYNTHETIC_DEMO_NOTICE}
      </Txt>
    </View>
  )
}
