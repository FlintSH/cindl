import { shortcuts } from '../shortcuts.ts'
import { Keys } from '../ui/primitives.tsx'
import { Overlay } from './Overlay.tsx'
import styles from './palette.module.css'

export function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <Overlay open={open} onClose={onClose} label="Keyboard shortcuts">
      <div className={styles.palette}>
        <h2 className={styles.dialogTitle}>Keyboard shortcuts</h2>
        <ul className={styles.results}>
          {shortcuts.map((shortcut) => (
            <li key={shortcut.id} className={styles.result} data-static>
              <span className={styles.label}>{shortcut.label}</span>
              <Keys keys={shortcut.keys} />
            </li>
          ))}
        </ul>
      </div>
    </Overlay>
  )
}
