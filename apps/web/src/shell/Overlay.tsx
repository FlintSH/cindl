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
  initialFocus,
}: {
  open: boolean
  onClose: () => void
  label: string
  children: ReactNode
  placement?: 'center' | 'top' | 'side' | 'sheet'
  /**
   * Where focus starts, as a selector inside the dialog. Without one the
   * browser picks the first focusable element, which may be a control the
   * keyboard order skips (an unselected tab).
   */
  initialFocus?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      if (initialFocus) dialog.querySelector<HTMLElement>(initialFocus)?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open, initialFocus])
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
