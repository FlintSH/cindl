import { useCan, useCindlApi, useConversations } from '@cindl/client-react'
import { isCindlError } from '@cindl/contracts'
import { Pin, Plus, X } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { navigate } from '../router.ts'
import { fuzzyScore } from '../shell/CommandPalette.tsx'
import { Overlay } from '../shell/Overlay.tsx'
import { Badge, Button } from '../ui/primitives.tsx'
import { listTime } from './format.ts'
import { useFinished } from './finished.ts'
import { noteFresh, noteSwitch } from './places.ts'
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
  const finished = useFinished()
  const [error, setError] = useState<string>()
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
    // The conversation already shown: nothing to open (at #/talk, navigating
    // to it would only change the address and remount the view), and focus
    // goes back to the switcher as the dialog closes.
    if (id === currentId) return
    noteSwitch()
    navigate({ view: 'talk', conversationId: id })
  }
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const rows = () => [...(list.current?.querySelectorAll('button') ?? [])]
  // Enter opens the best match; the arrows walk the list and come back up to
  // the search box; typing from the list goes on in the search box.
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && filtered[0]) {
      event.preventDefault()
      open_(filtered[0].id)
    } else if (event.key === 'ArrowDown' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      rows()[0]?.focus()
    }
  }
  const listKeys = (event: KeyboardEvent<HTMLUListElement>) => {
    const all = rows()
    const at = all.findIndex((row) => row === document.activeElement)
    if (at < 0) return
    const to =
      event.key === 'ArrowDown'
        ? Math.min(at + 1, all.length - 1)
        : event.key === 'ArrowUp'
          ? at - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? all.length - 1
              : undefined
    if (to !== undefined) {
      event.preventDefault()
      if (to < 0) search.current?.focus()
      else all[to]?.focus()
    } else if (
      // Space stays with the row: a button acts on it (at key-up, so moving
      // focus here would type a space into the search instead).
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.nativeEvent.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      search.current?.focus()
    }
  }
  return (
    // The search box takes focus at every width: on a phone the sheet's close
    // button comes first in the DOM, and the dialog would otherwise focus it.
    <Overlay
      open={open}
      onClose={close}
      label="Conversations"
      placement="top"
      initialFocus="input"
    >
      <div className={styles.history}>
        {/* Shown on phones, where the list is a bottom sheet (as on Android). */}
        <div className={styles.historyHead}>
          <h2 className={styles.historyHeading}>Conversations</h2>
          <Button variant="quiet" icon aria-label="Close conversations" onClick={close}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        <input
          ref={search}
          className={styles.historySearch}
          autoFocus
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={searchKeys}
        />
        <ul ref={list} className={styles.historyList} onKeyDown={listKeys}>
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
                {finished.has(conversation.id) ? (
                  <Badge tone="success">Done</Badge>
                ) : null}
                <span className={styles.historyMeta}>
                  {listTime(conversation.updatedAt)}
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
                void api.call('conversations.create', {}).then(
                  (created) => {
                    noteFresh()
                    open_(created.id)
                  },
                  (err: unknown) =>
                    setError(
                      isCindlError(err)
                        ? err.message
                        : 'The side conversation could not be started.',
                    ),
                )
              }
            >
              <Plus size={15} aria-hidden="true" /> New side conversation
            </button>
            {error ? (
              <p className={styles.historyEmpty} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Overlay>
  )
}
