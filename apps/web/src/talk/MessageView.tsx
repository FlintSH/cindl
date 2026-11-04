import type { Message } from '@cindl/contracts'
import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Markdown } from './Markdown.tsx'
import { ToolRow } from './ToolRow.tsx'
import { elapsed, fullTime, messageTime, momentInSentence } from './format.ts'
import styles from './talk.module.css'

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

export function MessageView({
  message,
  agentName,
  selectedToolId,
  blockedToolIds,
  onSelectTool,
}: {
  message: Message
  agentName: string
  selectedToolId: string | undefined
  blockedToolIds: ReadonlySet<string>
  onSelectTool: (toolId: string) => void
}) {
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
        <div className={styles.userBubble}>
          <p className={styles.userText}>{text}</p>
        </div>
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
      aria-label={`${agentName}${moment ? `, ${moment}` : ''}`}
      aria-busy={streaming}
    >
      <header className={styles.assistantMeta}>
        <span className={styles.assistantName}>{agentName}</span>
        {note ? <span className={styles.origin}>{note}</span> : null}
        {streaming ? (
          <Working since={message.createdAt} />
        ) : time ? (
          <time dateTime={message.createdAt} title={fullTime(message.createdAt)}>
            {time}
          </time>
        ) : null}
        {!streaming && hasWords ? (
          <CopyButton label="Copy reply" className={styles.copyReply} text={words} />
        ) : null}
      </header>
      <div className={styles.assistantBody}>
        {message.parts.map((part, index) => {
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
