import { useCindlApi, useLink } from '@cindl/client-react'
import { HermesOrigin, isCindlError } from '@cindl/contracts'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { hermesSignInPage } from '../platform/client.ts'
import { useClientKind } from '../platform/clientKind.ts'
import { Mark } from '../ui/Mark.tsx'
import { Button } from '../ui/primitives.tsx'
import styles from './notconnected.module.css'
import { signInHere, signOutHere, useSignOutUnconfirmed } from './session.ts'

/** Shown when this client has no Hermes session; how it signs in depends on the client. */
export function SignIn() {
  return useClientKind() === 'hermes' ? <SameOriginSignIn /> : <NativeSignIn />
}

/**
 * Cindl served from its Hermes's own origin: the browser signs in on Hermes's
 * own login page, which sets Hermes's HttpOnly session cookie and sends the
 * browser back here (`next`). Cindl never sees the password or the session.
 */
function SameOriginSignIn() {
  const api = useCindlApi()
  const unconfirmed = useSignOutUnconfirmed()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'checking' | 'signing-out'>()
  // Hermes confirmed the sign-out this screen tried again.
  const [confirmed, setConfirmed] = useState(false)
  const signInButton = useRef<HTMLButtonElement>(null)
  // The button pressed is disabled while its request is out, which takes
  // focus off it in a browser. Once the request settles, focus goes back to
  // it, or to what replaced it, unless the owner moved focus meanwhile.
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    if (busy !== undefined) return
    const target = returnFocus.current
    returnFocus.current = null
    if (!target?.isConnected) return
    const active = target.ownerDocument.activeElement
    if (!active || active === target.ownerDocument.body || active === target)
      target.focus()
  }, [busy])
  const signIn = () => window.location.assign(hermesSignInPage())
  // Signed in elsewhere (another tab): check this browser's session again.
  const retry = async (button: HTMLButtonElement) => {
    returnFocus.current = button
    setError(undefined)
    setBusy('checking')
    try {
      await signInHere(api, window.location.origin)
    } catch (err) {
      setError(isCindlError(err) ? err.message : 'Sign-in did not complete.')
    } finally {
      setBusy(undefined)
    }
  }
  // Hermes did not confirm the last sign-out, so its cookie may still sign
  // this browser in: ask Hermes again.
  const signOutAgain = async (button: HTMLButtonElement) => {
    returnFocus.current = button
    setError(undefined)
    setBusy('signing-out')
    try {
      const result = await signOutHere(api)
      if (result.hermesConfirmed !== false) {
        setConfirmed(true)
        // The button pressed is gone: the next step is signing in.
        returnFocus.current = signInButton.current
      }
    } catch {
      setError('Signing out did not complete. Try again.')
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <div className={styles.region}>
      <div className={styles.card}>
        <Mark size={28} />
        <h1 className={styles.title}>Sign in to Hermes</h1>
        <p>
          This Cindl is served by your Hermes. Sign in on Hermes's own page and you come
          back here. Cindl never sees your password; your session stays in this browser.
        </p>
        {unconfirmed ? (
          <>
            <p>
              Hermes has not confirmed the sign-out, so this browser may still be signed
              in to it.
            </p>
            <div className={styles.actions}>
              <Button
                disabled={busy !== undefined}
                onClick={(event) => void signOutAgain(event.currentTarget)}
              >
                {busy === 'signing-out' ? 'Signing out…' : 'Sign out on Hermes'}
              </Button>
            </div>
          </>
        ) : confirmed ? (
          <p role="status">Hermes cleared its session cookie in this browser.</p>
        ) : null}
        {error ? (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button ref={signInButton} variant="primary" onClick={signIn}>
            Sign in on Hermes
          </Button>
          <Button
            variant="quiet"
            disabled={busy !== undefined}
            onClick={(event) => void retry(event.currentTarget)}
          >
            {busy === 'checking' ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Shown when a native client (desktop, later Android) has no Hermes session.
 * Sign-in happens in the system browser on Hermes's own page: Cindl never sees
 * or asks for a password or a 2FA code.
 */
function NativeSignIn() {
  const api = useCindlApi()
  const link = useLink()
  const fieldId = useId()
  const [origin, setOrigin] = useState(link.server?.origin ?? '')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // Only the latest attempt may change this screen. One abandoned with "Stop
  // waiting" still settles later (main cancels it when a new one starts), and
  // must not report or unlock anything over the attempt that replaced it.
  const attempt = useRef(0)
  const stopWaiting = () => {
    attempt.current += 1
    setBusy(false)
  }
  const submit = async () => {
    const parsed = HermesOrigin.safeParse(origin.trim())
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? 'Enter the address of your Hermes server.',
      )
      return
    }
    const mine = ++attempt.current
    setError(undefined)
    setBusy(true)
    try {
      await signInHere(api, parsed.data)
    } catch (err) {
      if (mine === attempt.current)
        setError(isCindlError(err) ? err.message : 'Sign-in did not complete.')
    } finally {
      if (mine === attempt.current) setBusy(false)
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
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={busy || !origin.trim()}>
            {busy ? 'Waiting for the browser…' : 'Sign in'}
          </Button>
          {busy ? (
            // The browser leg may never come back (a closed tab); this frees the
            // screen. It cannot abort the sign-in in the system browser.
            <Button variant="quiet" onClick={stopWaiting}>
              Stop waiting
            </Button>
          ) : null}
        </div>
        {busy ? (
          <p className={styles.small} role="status">
            Finish signing in in your browser. Stop waiting frees this form for another
            try; it does not cancel the sign-in in your browser.
          </p>
        ) : null}
        <p className={styles.small}>
          Only https addresses are accepted (plain http only for 127.0.0.1 or [::1]).
          Signing out later is local to this device: Hermes v0.22.5 cannot revoke issued
          tokens.
        </p>
      </form>
    </div>
  )
}
