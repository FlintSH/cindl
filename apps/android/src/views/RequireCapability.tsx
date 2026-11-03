import { useCapability } from '@cindl/client-react'
import { capabilityUsable, type Capability, type CapabilityId } from '@cindl/contracts'
import type { ReactNode } from 'react'
import { Text } from 'react-native'
import { useTheme } from '../theme/theme.tsx'
import { Callout } from '../ui/primitives.tsx'

/** Wording for a capability that is not usable (web parity: views/Capability.tsx). */
export function unavailableCopy(capability: Capability | undefined) {
  const reason =
    capability?.reason ??
    (capability?.state === 'unknown' || !capability
      ? 'Not checked on this connection yet.'
      : 'Not available right now.')
  const state =
    capability?.state === 'unsupported'
      ? 'Not supported'
      : capability?.state === 'unavailable'
        ? 'Unavailable'
        : 'Unknown'
  return { state, reason }
}

/**
 * Renders children only when a capability is usable; otherwise says exactly
 * why not. Absent capabilities are "not checked yet", never "working", and
 * children (with their reads) do not mount until the check passes.
 */
export function RequireCapability({
  id,
  label,
  children,
}: {
  id: CapabilityId
  label: string
  children: ReactNode
}) {
  const theme = useTheme()
  const capability = useCapability(id)
  if (capabilityUsable(capability)) return <>{children}</>
  const { state, reason } = unavailableCopy(capability)
  return (
    <Callout>
      <Text style={[theme.text.ui, { color: theme.colors.textSecondary }]}>
        <Text style={{ fontFamily: theme.fonts.semibold, color: theme.colors.text }}>
          {`${label}: ${state}.`}
        </Text>
        {` ${reason}`}
      </Text>
    </Callout>
  )
}
