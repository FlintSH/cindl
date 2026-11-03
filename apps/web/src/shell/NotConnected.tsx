import { Mark } from '../ui/Mark.tsx'
import styles from './notconnected.module.css'

/**
 * Shown when this build has no way to reach Hermes. Honest about why and
 * what would change it; it never substitutes demo data.
 */
export function NotConnected() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Mark size={28} />
        <h1 className={styles.title}>Cindl is not connected</h1>
        <p>
          The web client talks to Hermes only from the same origin as your{' '}
          <code>hermes serve</code> backend, using its own sign-in. This build is not
          mounted there, so it cannot reach Hermes, and it does not invent data in the
          meantime.
        </p>
        <ul className={styles.options}>
          <li>
            Use the <strong>Cindl desktop app</strong>, which signs in with the Hermes
            native flow.
          </li>
          <li>
            Use the <strong>Cindl Android app</strong>.
          </li>
          <li>
            Developers can run the clearly labelled synthetic demo with{' '}
            <code>pnpm --filter @cindl/web dev:demo</code>.
          </li>
        </ul>
        <p className={styles.small}>See the handbook: Clients, Web.</p>
      </div>
    </main>
  )
}
