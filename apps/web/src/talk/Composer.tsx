import { useCan, useCindlApi, useLink } from '@cindl/client-react'
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

/** Failures that certainly happened before anything reached Hermes. */
const NOT_SENT = new Set([
  'invalid',
  'offline',
  'unsupported',
  'unavailable',
  'unauthenticated',
])

/**
 * Non-blocking: you can send while Hermes works or waits (Hermes queues,
 * steers or redirects). Enter sends, Shift+Enter adds a line. Sending and
 * stopping are offered only when their capabilities are usable. When the
 * outcome of a send is unknown, the text is not silently restored (that would
 * invite a duplicate); the owner can put it back explicitly.
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
  const canSend = useCan('chat.stream')
  const canInterrupt = useCan('chat.interrupt')
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [unconfirmed, setUnconfirmed] = useState<string>()
  const input = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])
  const connected = link.phase === 'online'
  const ready = connected && canSend
  const submit = async () => {
    const value = text.trim()
    if (!value || !ready) return
    setError(undefined)
    setUnconfirmed(undefined)
    setText('')
    try {
      await api.call('prompt.submit', {
        conversationId,
        clientId: newClientId(),
        text: value,
      })
    } catch (err) {
      if (isCindlError(err) && NOT_SENT.has(err.code)) {
        setText(value)
        setError(err.message)
      } else {
        setUnconfirmed(value)
        setError(
          'Cindl could not confirm whether this message was sent. Check the conversation before sending it again.',
        )
      }
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
        <div className={styles.composerError} role="alert">
          <p>{error}</p>
          {unconfirmed !== undefined ? (
            <Button
              variant="quiet"
              onClick={() => {
                setText(unconfirmed)
                setUnconfirmed(undefined)
                setError(undefined)
              }}
            >
              Put the text back
            </Button>
          ) : null}
        </div>
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
            ready
              ? `Message ${agentName}`
              : connected
                ? 'Sending is not available on this connection.'
                : 'Not connected. Messages cannot be sent.'
          }
          value={text}
          disabled={!ready}
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
          {canStop && canInterrupt ? (
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
            disabled={!ready || !text.trim()}
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
