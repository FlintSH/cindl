import { useCindlState } from '@cindl/client-react'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './shell.module.css'

/** Shows client notices (e.g. "tokens kept in memory only") until dismissed. */
export function Notices() {
  const notices = useCindlState((state) => state.notices)
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  const visible = notices.filter((n) => !dismissed.has(n.id)).slice(-3)
  if (!visible.length) return null
  return (
    <div className={styles.notices} role="status" aria-live="polite">
      {visible.map((notice) => (
        <div key={notice.id} className={styles.notice} data-level={notice.level}>
          <p>{notice.message}</p>
          <Button
            variant="quiet"
            icon
            aria-label="Dismiss notice"
            onClick={() => setDismissed((current) => new Set([...current, notice.id]))}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ))}
    </div>
  )
}
