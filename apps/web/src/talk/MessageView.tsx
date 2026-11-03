import type { Message } from '@cindl/contracts'
import { ChevronDown } from 'lucide-react'
import { Markdown } from './Markdown.tsx'
import { ToolRow } from './ToolRow.tsx'
import { clockTime } from './format.ts'
import styles from './talk.module.css'

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
  const time = clockTime(message.createdAt)
  if (message.role === 'user') {
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
    return (
      <article className={styles.user} aria-label={`You${time ? ` at ${time}` : ''}`}>
        <div className={styles.userBubble}>
          <p className={styles.userText}>{text}</p>
        </div>
      </article>
    )
  }
  const note = message.origin ? originNote[message.origin] : undefined
  return (
    <article
      className={styles.assistant}
      aria-label={`${agentName}${time ? ` at ${time}` : ''}`}
      aria-busy={message.status === 'streaming'}
    >
      <header className={styles.assistantMeta}>
        <span className={styles.assistantName}>{agentName}</span>
        {note ? <span className={styles.origin}>{note}</span> : null}
        {time ? <time dateTime={message.createdAt}>{time}</time> : null}
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
        {message.status === 'streaming' && message.parts.length === 0 ? (
          <p className={styles.thinking}>Working…</p>
        ) : null}
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
