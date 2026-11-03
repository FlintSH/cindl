import { useEffect, useRef, type ReactNode } from 'react'
import styles from './overlay.module.css'

/**
 * Modal surface on the native <dialog> element: focus moves in, Escape
 * closes, the rest of the page is inert, focus returns on close.
 */
export function Overlay({
  open,
  onClose,
  label,
  children,
  placement = 'center',
}: {
  open: boolean
  onClose: () => void
  label: string
  children: ReactNode
  placement?: 'center' | 'top' | 'side'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      data-placement={placement}
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      {open ? children : null}
    </dialog>
  )
}
