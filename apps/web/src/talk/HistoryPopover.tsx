import { useCan, useCindlApi, useConversations } from '@cindl/client-react'
import { Pin, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { navigate } from '../router.ts'
import { fuzzyScore } from '../shell/CommandPalette.tsx'
import { Overlay } from '../shell/Overlay.tsx'
import { Badge } from '../ui/primitives.tsx'
import { relativeDay } from './format.ts'
import styles from './talk.module.css'

export function HistoryPopover({
  open,
  onClose,
  currentId,
}: {
  open: boolean
  onClose: () => void
  currentId: string | undefined
}) {
  const api = useCindlApi()
  const conversations = useConversations()
  const canCreate = useCan('sessions.create')
  const [query, setQuery] = useState('')
  const filtered = useMemo(
    () =>
      conversations.filter(
        (c) => fuzzyScore(query, `${c.title} ${c.preview ?? ''}`) !== undefined,
      ),
    [conversations, query],
  )
  const close = () => {
    setQuery('')
    onClose()
  }
  const open_ = (id: string) => {
    close()
    navigate({ view: 'talk', conversationId: id })
  }
  return (
    <Overlay open={open} onClose={close} label="Conversations" placement="top">
      <div className={styles.history}>
        <input
          className={styles.historySearch}
          autoFocus
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className={styles.historyList}>
          {filtered.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className={styles.historyItem}
                aria-current={conversation.id === currentId ? 'true' : undefined}
                onClick={() => open_(conversation.id)}
              >
                <span className={styles.historyTitle}>
                  {conversation.kind === 'main' ? (
                    <Pin size={13} aria-label="Main" />
                  ) : null}
                  {conversation.title}
                </span>
                {conversation.status === 'waiting-on-you' ? (
                  <Badge tone="accent">Needs you</Badge>
                ) : null}
                {conversation.status === 'working' ? (
                  <Badge tone="info">Working</Badge>
                ) : null}
                <span className={styles.historyMeta}>
                  {relativeDay(conversation.updatedAt)}
                </span>
                {conversation.preview ? (
                  <span className={styles.historyPreview}>{conversation.preview}</span>
                ) : null}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className={styles.historyEmpty}>No conversations match.</li>
          ) : null}
        </ul>
        {canCreate ? (
          <div className={styles.historyFooter}>
            <button
              type="button"
              className={styles.historyNew}
              onClick={() =>
                void api
                  .call('conversations.create', {})
                  .then((created) => open_(created.id))
              }
            >
              <Plus size={15} aria-hidden="true" /> New side conversation
            </button>
          </div>
        ) : null}
      </div>
    </Overlay>
  )
}
