import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { copyText } from '../platform/clipboard.ts'
import { Button } from './primitives.tsx'

/**
 * Copies `text()` (read at the click, so it is never stale) and says so
 * where the owner is looking: a check for a moment, and the same news for a
 * screen reader.
 */
export function CopyButton({
  label,
  text,
  className,
}: {
  label: string
  text: () => string
  /** CSS module classes may be undefined in a type's eyes. */
  className?: string | undefined
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const reset = window.setTimeout(() => setState('idle'), 1500)
    return () => window.clearTimeout(reset)
  }, [state])
  const said = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''
  return (
    <>
      <Button
        variant="quiet"
        icon
        className={className}
        aria-label={label}
        title={said || label}
        data-state={state}
        onClick={() =>
          void copyText(text()).then((ok) => setState(ok ? 'copied' : 'failed'))
        }
      >
        {state === 'copied' ? (
          <Check size={15} aria-hidden="true" />
        ) : (
          <Copy size={15} aria-hidden="true" />
        )}
      </Button>
      <span role="status" className="visually-hidden">
        {said}
      </span>
    </>
  )
}
