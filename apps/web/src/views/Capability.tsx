import { useCapability } from '@cindl/client-react'
import { capabilityUsable, type CapabilityId } from '@cindl/contracts'
import type { ReactNode } from 'react'
import styles from './views.module.css'

/**
 * Renders children only when a capability is usable; otherwise says exactly
 * why not. Absent capabilities are "not checked yet", never "working".
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
  const capability = useCapability(id)
  if (capabilityUsable(capability)) return <>{children}</>
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
  return (
    <p className={styles.unsupported}>
      <strong>
        {label}: {state}.
      </strong>{' '}
      {reason}
    </p>
  )
}
