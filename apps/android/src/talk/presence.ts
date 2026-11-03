import type { ConversationActivity } from '@cindl/client-core'
import {
  SYNTHETIC_DEMO_LABEL,
  type LinkPhase,
  type LinkState,
  type ServerRequest,
} from '@cindl/contracts'
import type { Tone } from '../ui/primitives.tsx'

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

/** Connection wording shared with web (apps/web/src/shell/LinkStatus.tsx). */
export function linkCopy(phase: LinkPhase, demo: boolean | undefined) {
  if (demo)
    return { label: `${SYNTHETIC_DEMO_LABEL}, not connected`, tone: 'warning' as Tone }
  return phaseCopy[phase]
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`

/** Header presence line (web parity: apps/web/src/talk/presence.ts). Observed states only. */
export function presenceCopy(
  link: LinkState,
  activity: ConversationActivity,
): { tone: Tone; text: string; aside?: string } {
  if (link.phase !== 'online' && !link.demo) {
    const copy = linkCopy(link.phase, false)
    return { tone: copy.tone, text: copy.label }
  }
  const aside = activity.otherExecuting
    ? `${plural(activity.otherExecuting, 'other conversation')} working`
    : undefined
  const withAside = (copy: { tone: Tone; text: string }) =>
    aside ? { ...copy, aside } : copy
  switch (activity.phase) {
    case 'waiting-on-you': {
      const count = (kind: ServerRequest['kind']) =>
        activity.openRequests.filter((r) => r.kind === kind).length
      const elsewhere = count('unsupported')
      const parts = [
        count('approval') ? plural(count('approval'), 'approval') : '',
        count('clarify') ? plural(count('clarify'), 'question') : '',
        elsewhere ? `${plural(elsewhere, 'prompt')} outside Cindl` : '',
      ]
      return withAside({
        tone: 'accent',
        text: `Waiting on you: ${parts.filter(Boolean).join(', ')}`,
      })
    }
    case 'executing': {
      const step = activity.executingTools.at(-1)?.title
      return withAside({ tone: 'info', text: step ? `Working: ${step}` : 'Working' })
    }
    case 'queued':
      return withAside({
        tone: 'info',
        text: `${plural(activity.queuedPrompts, 'message')} queued`,
      })
    case 'unknown':
      return withAside({ tone: 'neutral', text: 'Status unknown' })
    case 'idle':
      return withAside({ tone: 'neutral', text: 'Idle' })
  }
}

/** Composer footnote: what sending now will do. */
export function composerHint(activity: ConversationActivity): string | undefined {
  switch (activity.phase) {
    case 'waiting-on-you':
      return activity.openRequests.every((r) => r.kind === 'unsupported')
        ? 'Hermes is waiting for an answer outside Cindl. You can still send a message.'
        : 'Hermes is waiting for your answer above. You can still send a message.'
    case 'executing':
      return 'Hermes is working. New messages queue or steer the current turn.'
    case 'queued':
      return 'Your message is queued behind the current turn.'
    default:
      return undefined
  }
}
