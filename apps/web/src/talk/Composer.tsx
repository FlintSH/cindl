import { useCindlApi, useLink } from '@cindl/client-react'
import { isCindlError } from '@cindl/contracts'
import { ArrowUp, Square } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from './talk.module.css'

export interface ComposerHandle {
  focus(): void
}

const newClientId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Non-blocking: you can send while Hermes works or waits (Hermes queues,
 * steers or redirects). Enter sends, Shift+Enter adds a line. The hint says
 * what sending now will do, derived from observed state.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    conversationId: string
    canStop: boolean
    hint: string | undefined
    agentName: string
  }
>(function Composer({ conversationId, canStop, hint, agentName }, ref) {
  const api = useCindlApi()
  const link = useLink()
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const input = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])
  const online = link.phase === 'online'
  const submit = async () => {
    const value = text.trim()
    if (!value || !online) return
    setError(undefined)
    setText('')
    try {
      await api.call('prompt.submit', {
        conversationId,
        clientId: newClientId(),
        text: value,
      })
    } catch (err) {
      setText(value)
      setError(isCindlError(err) ? err.message : 'Your message was not sent.')
    }
  }
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {error ? (
        <p className={styles.composerError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.composerBox}>
        <label htmlFor="composer-input" className="visually-hidden">
          Message {agentName}
        </label>
        <textarea
          id="composer-input"
          ref={input}
          className={styles.composerInput}
          rows={1}
          placeholder={
            online ? `Message ${agentName}` : 'Not connected. Messages cannot be sent.'
          }
          value={text}
          disabled={!online}
          aria-describedby={hint ? 'composer-hint' : undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className={styles.composerActions}>
          {canStop ? (
            <Button
              variant="quiet"
              icon
              aria-label="Stop the current turn"
              title="Stop"
              onClick={() => void api.call('conversation.interrupt', { conversationId })}
            >
              <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            icon
            aria-label="Send"
            disabled={!online || !text.trim()}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {hint ? (
        <p className={styles.composerHint} id="composer-hint">
          {hint}
        </p>
      ) : null}
    </form>
  )
})
