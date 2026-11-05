import type { Message } from '@cindl/contracts'
import { ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Markdown } from './Markdown.tsx'
import { ToolRow } from './ToolRow.tsx'
import { WorkGroup } from './WorkGroup.tsx'
import { segmentsOf } from './workGroups.ts'
import { elapsed, fullTime, messageTime, momentInSentence } from './format.ts'
import styles from './talk.module.css'

/** Past this, an owner's message folds (after T3 Code): a pasted log never buries the thread. */
const LONG = { chars: 600, lines: 8 }

/** The owner's own message, folded to a few lines when it is long. */
function OwnText({ text }: { text: string }) {
  const long = text.length > LONG.chars || text.split('\n').length > LONG.lines
  const [open, setOpen] = useState(false)
  return (
    <div className={styles.userBubble} data-folded={long && !open ? 'true' : undefined}>
      <p className={styles.userText}>{text}</p>
      {long ? (
        <button
          type="button"
          className={styles.unfold}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show full message'}
        </button>
      ) : null}
    </div>
  )
}

/** While a reply streams, its header counts up from when it started. */
function Working({ since }: { since: string | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [])
  const took = elapsed(since, now)
  return (
    <span className={styles.working}>{took ? `Working for ${took}` : 'Working…'}</span>
  )
}

const originNote: Partial<Record<NonNullable<Message['origin']>, string>> = {
  routine: 'From a routine',
  proactive: 'Unprompted',
}

/**
 * What a streaming reply's header says, from the conversation's observed
 * phase: counting while Hermes works, "Waiting for you" while it is blocked on
 * the owner, nothing (just its time) when Cindl cannot tell. A reply blocked
 * overnight never claims to have worked all night.
 */
export type TurnState = 'working' | 'waiting' | undefined

export function turnStateOf(phase: string): TurnState {
  if (phase === 'waiting-on-you') return 'waiting'
  return phase === 'executing' || phase === 'queued' ? 'working' : undefined
}

export function MessageView({
  message,
  agentName,
  selectedToolId,
  blockedToolIds,
  onSelectTool,
  turn,
}: {
  message: Message
  agentName: string
  selectedToolId: string | undefined
  blockedToolIds: ReadonlySet<string>
  onSelectTool: (toolId: string) => void
  /** The conversation's turn, for a streaming reply's header. */
  turn?: TurnState
}) {
  // A step's row that becomes part of a work log (a second step arrived) is
  // a new element, which drops focus; React reports no blur for it, as it
  // happens in its commit. Focus follows the step; a blur lets go.
  const body = useRef<HTMLDivElement>(null)
  const holding = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const held = holding.current
    if (!held || document.activeElement !== document.body) return
    for (const row of body.current?.querySelectorAll<HTMLElement>('[data-tool-id]') ?? [])
      if (row.dataset.toolId === held) {
        row.focus()
        break
      }
  })
  const time = messageTime(message.createdAt)
  // Spoken as part of the message's name: "You, today at 8:03 AM".
  const moment = momentInSentence(message.createdAt)
  if (message.role === 'user') {
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
    return (
      <article
        className={styles.user}
        aria-label={`You${moment ? `, ${moment}` : ''}`}
        title={fullTime(message.createdAt)}
      >
        <CopyButton label="Copy message" className={styles.copyMine} text={() => text} />
        <OwnText text={text} />
      </article>
    )
  }
  const note = message.origin ? originNote[message.origin] : undefined
  const streaming = message.status === 'streaming'
  // The reply's own words, as Markdown: steps and notices are not part of it.
  const words = () =>
    message.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n\n')
  const hasWords = message.parts.some((part) => part.type === 'text' && part.text.trim())
  return (
    <article
      className={styles.assistant}
      // Named as its header reads, as on Android: working, waiting, or its time.
      aria-label={`${agentName}${
        streaming && turn === 'working'
          ? ', working'
          : streaming && turn === 'waiting'
            ? ', waiting for you'
            : moment
              ? `, ${moment}`
              : ''
      }`}
      aria-busy={streaming}
    >
      <header className={styles.assistantMeta}>
        <span className={styles.assistantName}>{agentName}</span>
        {note ? <span className={styles.origin}>{note}</span> : null}
        {streaming && turn === 'working' ? (
          <Working since={message.createdAt} />
        ) : streaming && turn === 'waiting' ? (
          <span className={styles.working}>Waiting for you</span>
        ) : time ? (
          <time dateTime={message.createdAt} title={fullTime(message.createdAt)}>
            {time}
          </time>
        ) : null}
        {!streaming && hasWords ? (
          <CopyButton label="Copy reply" className={styles.copyReply} text={words} />
        ) : null}
      </header>
      <div
        ref={body}
        className={styles.assistantBody}
        onFocus={(event) => {
          holding.current =
            event.target instanceof HTMLElement ? event.target.dataset.toolId : undefined
        }}
        onBlur={() => {
          holding.current = undefined
        }}
      >
        {segmentsOf(message.parts).map((segment) => {
          if (segment.kind === 'work')
            return (
              <WorkGroup
                key={segment.key}
                groupKey={`${message.id}:${segment.key}`}
                toolIds={segment.toolIds}
                selectedToolId={selectedToolId}
                blockedToolIds={blockedToolIds}
                onSelectTool={onSelectTool}
              />
            )
          const { part, index } = segment
          switch (part.type) {
            case 'text':
              return <Markdown key={index} text={part.text} />
            case 'reasoning':
              return (
                <details key={index} className={styles.reasoning}>
                  <summary>
                    <ChevronDown size={14} aria-hidden="true" /> Reasoning
                  </summary>
                  <p>{part.text}</p>
                </details>
              )
            case 'tool':
              return (
                <ToolRow
                  key={part.toolId}
                  toolId={part.toolId}
                  selected={selectedToolId === part.toolId}
                  blocked={blockedToolIds.has(part.toolId)}
                  onSelect={onSelectTool}
                />
              )
            case 'notice':
              return (
                <p key={index} className={styles.notice} data-level={part.level}>
                  {part.text}
                </p>
              )
          }
        })}
        {message.status === 'interrupted' ? (
          <p className={styles.notice}>Stopped.</p>
        ) : null}
        {message.status === 'error' ? (
          <p className={styles.notice} data-level="error">
            This reply ended with an error.
          </p>
        ) : null}
      </div>
    </article>
  )
}
