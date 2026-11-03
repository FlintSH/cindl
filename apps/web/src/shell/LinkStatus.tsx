import { useLink } from '@cindl/client-react'
import { SYNTHETIC_DEMO_LABEL, type LinkPhase } from '@cindl/contracts'
import { Dot, type Tone } from '../ui/primitives.tsx'

const phaseCopy: Record<LinkPhase, { label: string; tone: Tone }> = {
  unconfigured: { label: 'Not set up', tone: 'neutral' },
  'signed-out': { label: 'Signed out', tone: 'warning' },
  connecting: { label: 'Connecting', tone: 'neutral' },
  online: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  offline: { label: 'Offline', tone: 'warning' },
  incompatible: { label: 'Incompatible Hermes version', tone: 'danger' },
  error: { label: 'Connection error', tone: 'danger' },
}

export function linkCopy(phase: LinkPhase, demo: boolean | undefined) {
  if (demo)
    return { label: `${SYNTHETIC_DEMO_LABEL}, not connected`, tone: 'warning' as Tone }
  return phaseCopy[phase]
}

export function LinkStatusDot() {
  const link = useLink()
  const copy = linkCopy(link.phase, link.demo)
  return <Dot tone={copy.tone} label={copy.label} />
}
