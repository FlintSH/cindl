import { useCan, useCindlApi, useLink, useMessages } from '@cindl/client-react'
import { isCindlError, type Message } from '@cindl/contracts'
import { ArrowUp, Square } from 'lucide-react'
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '../ui/primitives.tsx'
import { keepPlace, placeOf } from './places.ts'
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

const textOf = (message: Message) =>
  message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')

/** Whether the caret sits on the text's first line (or last), as prompt recall asks. */
const onFirstLine = (el: HTMLTextAreaElement) =>
  !el.value.slice(0, el.selectionStart).includes('\n')
const onLastLine = (el: HTMLTextAreaElement) =>
  !el.value.slice(el.selectionEnd).includes('\n')

/**
 * Non-blocking: you can send while Hermes works or waits (Hermes queues,
 * steers or redirects). Enter sends, Shift+Enter adds a line. Sending and
 * stopping are offered only when their capabilities are usable. When the
 * outcome of a send is unknown, the text is not silently restored (that would
 * invite a duplicate); the owner can put it back explicitly.
 *
 * Laid out after T3 Code's composer: the text on top, a bar beneath it in the
 * same box with what sending does now on the left and one primary button on
 * the right. That button is Stop while Hermes works and the box is empty, and
 * Send as soon as there is text. Its clicks never take focus from the text.
 * ArrowUp in an empty box (or on the first line of a recalled message) brings
 * back what you sent here before; ArrowDown goes forward again.
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
  // The unsent message belongs to its conversation (TalkView keys the composer
  // by conversation), and waits there while the owner is elsewhere.
  const [text, setTextNow] = useState(() => placeOf(conversationId).draft)
  const setText = (value: string) => {
    setTextNow(value)
    keepPlace(conversationId, { draft: value })
  }
  const [error, setError] = useState<string>()
  const [unconfirmed, setUnconfirmed] = useState<string>()
  const input = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])
  const connected = link.phase === 'online'
  const ready = connected && canSend
  // What the owner sent in this conversation, oldest first, for recall.
  const messages = useMessages(conversationId)
  const sent = useMemo(
    () =>
      messages
        .filter((m) => m.role === 'user')
        .map(textOf)
        .filter((t) => t.trim()),
    [messages],
  )
  const [recalled, setRecalled] = useState<number>()
  const recalling = recalled !== undefined && text === sent[recalled]
  const recall = (to: number | undefined) => {
    setRecalled(to)
    setText(to === undefined ? '' : (sent[to] ?? ''))
  }
  const running = canStop && canInterrupt
  const stopping = running && !text.trim()
  // Stop takes Send's place as soon as the box empties, under the same
  // pointer. A press right after it appears (the second click of a double
  // click on Send) is never taken as Stop.
  const stopShown = useRef(0)
  useLayoutEffect(() => {
    if (stopping) stopShown.current = performance.now()
  }, [stopping])
  const submit = async () => {
    const value = text.trim()
    if (!value || !ready) return
    setError(undefined)
    setUnconfirmed(undefined)
    setText('')
    // Sent from the button by keyboard, focus goes back to the text, not to
    // the Stop that replaces the button.
    input.current?.focus()
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
            const el = event.currentTarget
            const plain =
              !event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.nativeEvent.isComposing
            if (event.key === 'Enter' && plain) {
              event.preventDefault()
              void submit()
            } else if (
              event.key === 'ArrowUp' &&
              plain &&
              (text === '' || (recalling && onFirstLine(el)))
            ) {
              const to = recalling ? (recalled ?? 0) - 1 : sent.length - 1
              if (to < 0) return
              event.preventDefault()
              recall(to)
            } else if (
              event.key === 'ArrowDown' &&
              plain &&
              recalling &&
              onLastLine(el)
            ) {
              event.preventDefault()
              const to = (recalled ?? 0) + 1
              recall(to < sent.length ? to : undefined)
            }
          }}
        />
        <div className={styles.composerBar}>
          {hint ? (
            <p className={styles.composerHint} id="composer-hint">
              {hint}
            </p>
          ) : (
            <p className={styles.composerKeys} aria-hidden="true">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd> <kbd>Enter</kbd> for a new line
              {sent.length ? (
                <>
                  {' '}
                  · <kbd>↑</kbd> for your last message
                </>
              ) : null}
            </p>
          )}
          <div className={styles.composerActions}>
            {stopping ? (
              <Button
                key="stop"
                icon
                className={styles.stop}
                aria-label="Stop the current turn"
                title="Stop the current turn"
                // Its press never takes focus from the text (it goes as it lands).
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  if (event.detail > 1 || performance.now() - stopShown.current < 500)
                    return
                  void api.call('conversation.interrupt', { conversationId })
                  input.current?.focus()
                }}
              >
                <Square
                  size={11}
                  fill="currentColor"
                  strokeWidth={0}
                  aria-hidden="true"
                />
              </Button>
            ) : (
              // Ember only once there is something to send: an empty box has no intent yet.
              <Button
                key="send"
                type="submit"
                variant="primary"
                icon
                className={styles.send}
                aria-label="Send"
                title={
                  running
                    ? 'Send (Enter): Hermes queues or steers with it'
                    : 'Send (Enter)'
                }
                disabled={!ready || !text.trim()}
                onMouseDown={(event) => event.preventDefault()}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  )
})
