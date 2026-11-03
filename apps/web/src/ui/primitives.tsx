import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { keyLabel } from '../shortcuts.ts'
import styles from './primitives.module.css'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'quiet' | 'danger'
  icon?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', icon = false, className, type = 'button', ...rest },
  ref,
) {
  const classes = [
    styles.button,
    variant === 'primary' && styles.primary,
    variant === 'quiet' && styles.quiet,
    variant === 'danger' && styles.danger,
    icon && styles.icon,
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return <button ref={ref} type={type} className={classes} {...rest} />
})

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: Tone
  children: ReactNode
}) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  )
}

export function Dot({ tone = 'neutral', label }: { tone?: Tone; label?: string }) {
  return (
    <span
      className={styles.dot}
      data-tone={tone}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  )
}

export function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className={styles.keys}>
      {keys.map((key) => (
        <kbd key={key} className={styles.kbd}>
          {keyLabel(key)}
        </kbd>
      ))}
    </span>
  )
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 className={styles['section-title']} id={id}>
      {children}
    </h2>
  )
}
