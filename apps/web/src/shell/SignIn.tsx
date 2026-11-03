import { useCindlApi, useLink } from '@cindl/client-react'
import { HermesOrigin, isCindlError } from '@cindl/contracts'
import { useId, useState } from 'react'
import { Mark } from '../ui/Mark.tsx'
import { Button } from '../ui/primitives.tsx'
import styles from './notconnected.module.css'

/**
 * Shown when a native client (desktop, later Android) has no Hermes session.
 * Sign-in happens in the system browser on Hermes's own page: Cindl never sees
 * or asks for a password or a 2FA code.
 */
export function SignIn() {
  const api = useCindlApi()
  const link = useLink()
  const fieldId = useId()
  const [origin, setOrigin] = useState(link.server?.origin ?? '')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const parsed = HermesOrigin.safeParse(origin.trim())
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? 'Enter the address of your Hermes server.',
      )
      return
    }
    setError(undefined)
    setBusy(true)
    try {
      await api.call('auth.signIn', { origin: parsed.data })
    } catch (err) {
      setError(
        isCindlError(err) ? err.message : 'Sign-in did not complete. Nothing was saved.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.region}>
      <form
        className={styles.card}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Mark size={28} />
        <h1 className={styles.title}>
          {link.phase === 'signed-out' ? 'Signed out' : 'Connect to Hermes'}
        </h1>
        <p>
          Enter the address of your <code>hermes serve</code> backend. Your browser opens
          Hermes's own sign-in page; Cindl never sees your password or verification codes.
        </p>
        <label htmlFor={fieldId} className={styles.small}>
          Hermes address
        </label>
        <input
          id={fieldId}
          className={styles.field}
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="https://hermes.example.test"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${fieldId}-error` : undefined}
        />
        {error ? (
          <p className={styles.fieldError} id={`${fieldId}-error`} role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="primary" disabled={busy || !origin.trim()}>
            {busy ? 'Waiting for the browser…' : 'Sign in'}
          </Button>
        </div>
        <p className={styles.small}>
          Only https addresses are accepted (plain http only for 127.0.0.1 or [::1]).
          Signing out later is local to this device: Hermes v0.22.5 cannot revoke issued
          tokens.
        </p>
      </form>
    </div>
  )
}
