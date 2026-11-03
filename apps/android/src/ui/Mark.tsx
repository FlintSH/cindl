import Svg, { Path } from 'react-native-svg'
import { useTheme } from '../theme/theme.tsx'

/** Cindl's ember mark (same glyph as apps/web/src/ui/Mark.tsx), drawn in the accent colour. */
export function Mark({ size = 22 }: { size?: number }) {
  const { colors } = useTheme()
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path
        d="M12 2.6c2.9 3.4 5.4 6.3 5.4 9.6a5.4 5.4 0 0 1-10.8 0c0-1.9 1-3.7 2.4-5.4.3 1.7 1.2 2.8 2.4 3.3-.5-2.9.1-5.2.6-7.5Z"
        fill={colors.accent}
      />
      <Path
        d="M8.2 20.4h7.6"
        stroke={colors.textTertiary}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </Svg>
  )
}
