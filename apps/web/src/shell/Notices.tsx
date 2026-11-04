import { useCindlState } from '@cindl/client-react'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './shell.module.css'

/** Client notices (e.g. "tokens kept in memory only"), in the flow above the view until dismissed. */
export function Notices() {
  const notices = useCindlState((state) => state.notices)
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  // A notice that comes again (a sign-out tried again, say) shows once, as
  // its latest, and is dismissed with every copy.
  const latest = new Map<string, (typeof notices)[number]>()
  for (const notice of notices)
    if (!dismissed.has(notice.id)) {
      latest.delete(notice.message)
      latest.set(notice.message, notice)
    }
  const visible = [...latest.values()].slice(-3)
  // The live region stays mounted so screen readers announce notices added later.
  return (
    <div className={styles.notices} role="status" aria-live="polite">
      {visible.map((notice) => (
        <div key={notice.id} className={styles.notice} data-level={notice.level}>
          <p>{notice.message}</p>
          <Button
            variant="quiet"
            icon
            aria-label="Dismiss notice"
            onClick={() =>
              setDismissed(
                (current) =>
                  new Set([
                    ...current,
                    ...notices
                      .filter((n) => n.message === notice.message)
                      .map((n) => n.id),
                  ]),
              )
            }
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ))}
    </div>
  )
}
