import type { Unavailable } from '../platform/client.ts'
import { Mark } from '../ui/Mark.tsx'
import { Button } from '../ui/primitives.tsx'
import styles from './notconnected.module.css'

/** While the page asks its origin whether Hermes is there. */
export function Checking() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Mark size={28} />
        <p role="status">Looking for Hermes…</p>
      </div>
    </main>
  )
}

const copy: Record<Unavailable, { title: string; body: string; retry: boolean }> = {
  'not-mounted': {
    title: 'Cindl is not connected',
    body: 'The web client talks to Hermes only from the same origin as your hermes serve backend, using its own sign-in. This page is not served from a Hermes origin, so it cannot reach Hermes, and it does not invent data in the meantime.',
    retry: false,
  },
  'no-answer': {
    title: 'Hermes did not answer',
    body: 'This page asked its own origin for Hermes and got no answer in time: Hermes may be restarting, or the network dropped. Nothing is shown until Hermes answers.',
    retry: true,
  },
  'no-sign-in': {
    title: 'Hermes offers no sign-in for browsers',
    body: 'Hermes answered, but it does not offer the browser sign-in Cindl uses: it may be running in loopback-token mode, which Cindl never uses, or still starting.',
    retry: true,
  },
  'insecure-origin': {
    title: 'Cindl is not connected',
    body: 'This page is served over plain http. Cindl signs in to Hermes only over https, or over http on this machine’s own address (127.0.0.1 or [::1]).',
    retry: false,
  },
}

/**
 * Shown when this build cannot reach Hermes. Honest about why and what would
 * change it; it never substitutes demo data.
 */
export function NotConnected({
  reason,
  onRetry,
}: {
  reason: Unavailable
  onRetry: () => void
}) {
  const { title, body, retry } = copy[reason]
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Mark size={28} />
        <h1 className={styles.title}>{title}</h1>
        <p>{body}</p>
        {retry ? (
          <div className={styles.actions}>
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <ul className={styles.options}>
            <li>
              The <strong>Cindl desktop and Android apps</strong> sign in with Hermes’s
              native flow from anywhere they can reach it.
            </li>
            <li>
              Developers can run the clearly labelled synthetic demo with{' '}
              <code>pnpm --filter @cindl/web dev:demo</code>.
            </li>
          </ul>
        )}
        <p className={styles.small}>See the handbook: Clients, Web.</p>
      </div>
    </main>
  )
}
