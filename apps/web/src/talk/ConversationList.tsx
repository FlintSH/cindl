import {
  useCan,
  useCindlApi,
  useConversations,
  useOpenRequests,
} from '@cindl/client-react'
import { isCindlError, type Conversation } from '@cindl/contracts'
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Hand,
  PanelLeftClose,
  Pin,
  Search,
  ShieldAlert,
  SquarePen,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { LIST_WIDTH, usePreference } from '../platform/preferences.ts'
import { navigate } from '../router.ts'
import { matchShortcut, shortcutText } from '../shortcuts.ts'
import { Button } from '../ui/primitives.tsx'
import { flatten, rowStatus, shelvesOf, type RowStatus } from './conversationList.ts'
import { useFinishedOutcomes } from './finished.ts'
import { noteCompose } from './places.ts'
import styles from './conversations.module.css'

/** Each status's icon, as on the cards and steps it stands for; after T3 Code, none animate. */
const statusIcons: Partial<Record<RowStatus['kind'], LucideIcon>> = {
  approval: ShieldAlert,
  question: CircleHelp,
  'needs-you': Hand,
  working: CircleDashed,
  done: CircleCheck,
  failed: CircleAlert,
  stopped: Ban,
}

export interface ConversationListHandle {
  focusSearch(): void
}

/** A clock that ticks every half minute, so "5m" turns into "6m" on its own. */
function useNow(every = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), every)
    return () => window.clearInterval(tick)
  }, [every])
  return now
}

/**
 * The conversation list beside Talk on wide screens, after T3 Code's thread
 * sidebar: the main conversation pinned, what needs the owner, then the rest
 * by recency. A row's right-hand slot shows its status when it has one worth
 * a glance ("Approval", "Question", "Working", "Done"), else how long ago it
 * changed. The arrow
 * keys move through it without opening anything; Enter opens. F2 (or a
 * double click) renames, when Hermes offers renaming. It stays mounted while
 * conversations change, so its place, search and focus hold.
 */
export const ConversationList = forwardRef<
  ConversationListHandle,
  {
    currentId: string | undefined
    onHide: () => void
    /** Puts focus in the open conversation's message box. */
    onCompose: () => void
  }
>(function ConversationList({ currentId, onHide, onCompose }, ref) {
  const api = useCindlApi()
  const conversations = useConversations()
  const canCreate = useCan('sessions.create')
  const canRename = useCan('sessions.rename')
  // Counted per conversation, as the margin's Waiting tab counts its own.
  const waiting = useOpenRequests()
  const finished = useFinishedOutcomes()
  const now = useNow()
  const [query, setQuery] = useState('')
  const shelves = useMemo(() => shelvesOf(conversations, query), [conversations, query])
  const flat = flatten(shelves)
  const [focusedId, setFocusedId] = useState<string>()
  // A row that moves to another shelf, or within one, is put back into the
  // page, which drops focus; React reports no blur for it, as it happens in
  // its commit. Focus follows the row; a blur (the owner moving on) lets go.
  const holding = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const held = holding.current
    if (held && document.activeElement === document.body) rows.current.get(held)?.focus()
  })
  // What the owner typed into a rename, kept if its row moves meanwhile.
  const [renameDrafts, setRenameDrafts] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  )
  const tabStop =
    flat.find((c) => c.id === focusedId)?.id ??
    flat.find((c) => c.id === currentId)?.id ??
    flat[0]?.id
  const rows = useRef(new Map<string, HTMLButtonElement | null>())
  const search = useRef<HTMLInputElement>(null)
  const [renaming, setRenaming] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const id = useId()
  useImperativeHandle(ref, () => ({ focusSearch: () => search.current?.focus() }), [])

  // Its width follows a drag on its edge (after T3 Code), live while dragging
  // and kept on the device once let go; the keyboard steps it by 16px.
  const nav = useRef<HTMLElement>(null)
  const [savedWidth, setSavedWidth] = usePreference('conversationsWidth')
  const [dragging, setDragging] = useState<number>()
  const width = dragging ?? savedWidth
  const clamp = (value: number) =>
    Math.round(Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, value)))
  useLayoutEffect(() => {
    nav.current?.style.setProperty('--list-width', `${width}px`)
  }, [width])
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const from = event.clientX
    const start = width
    handle.setPointerCapture(event.pointerId)
    const move = (e: globalThis.PointerEvent) =>
      setDragging(clamp(start + e.clientX - from))
    const end = (e: globalThis.PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      setSavedWidth(clamp(start + e.clientX - from))
      setDragging(undefined)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  // The open conversation's row stays in view as it changes.
  useEffect(() => {
    const row = currentId ? rows.current.get(currentId) : undefined
    if (typeof row?.scrollIntoView === 'function')
      row.scrollIntoView({ block: 'nearest' })
  }, [currentId])

  const open = (conversationId: string) => {
    if (conversationId !== currentId) navigate({ view: 'talk', conversationId })
  }
  const create = async () => {
    setProblem(undefined)
    try {
      const created = await api.call('conversations.create', {})
      noteCompose()
      navigate({ view: 'talk', conversationId: created.id })
    } catch (err) {
      setProblem(
        isCindlError(err) ? err.message : 'The side conversation could not be started.',
      )
    }
  }
  const focusRow = (conversationId: string | undefined) => {
    if (conversationId) rows.current.get(conversationId)?.focus()
  }
  const rowKeys = (
    event: KeyboardEvent<HTMLButtonElement>,
    conversation: Conversation,
  ) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const at = flat.findIndex((c) => c.id === conversation.id)
    const to =
      event.key === 'ArrowDown'
        ? flat[Math.min(at + 1, flat.length - 1)]
        : event.key === 'ArrowUp'
          ? at === 0
            ? undefined
            : flat[at - 1]
          : event.key === 'Home'
            ? flat[0]
            : event.key === 'End'
              ? flat.at(-1)
              : undefined
    if (event.key === 'ArrowUp' && at === 0) {
      event.preventDefault()
      search.current?.focus()
    } else if (to) {
      event.preventDefault()
      focusRow(to.id)
    } else if (event.key === 'F2' && canRename) {
      event.preventDefault()
      setRenaming(conversation.id)
    } else if (
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.nativeEvent.isComposing &&
      !matchShortcut(event.nativeEvent)
    ) {
      // Typing from the list goes on in its search box, and only there: Talk
      // sends other stray typing to the message box. Shortcuts keep their keys.
      event.stopPropagation()
      search.current?.focus()
    }
  }
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRow(flat[0]?.id)
    } else if (event.key === 'Enter' && flat[0]) {
      event.preventDefault()
      open(flat[0].id)
      focusRow(flat[0].id)
    } else if (event.key === 'Escape' && query) {
      event.preventDefault()
      setQuery('')
    }
  }

  return (
    <nav
      ref={nav}
      className={styles.list}
      aria-label="Conversations"
      data-conversation-list
      data-resizing={dragging === undefined ? undefined : 'true'}
    >
      <header className={styles.head}>
        <h2 className={styles.title}>Conversations</h2>
        {canCreate ? (
          <Button
            variant="quiet"
            icon
            aria-label="New side conversation"
            title={`New side conversation (${shortcutText('new-side')})`}
            onClick={() => void create()}
          >
            <SquarePen size={16} aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          variant="quiet"
          icon
          aria-label="Hide the conversation list"
          title={`Hide conversations (${shortcutText('toggle-conversations')})`}
          onClick={onHide}
        >
          <PanelLeftClose size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.searchRow}>
        <Search size={14} aria-hidden="true" className={styles.searchIcon} />
        <input
          ref={search}
          className={styles.search}
          placeholder="Search"
          aria-label="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={searchKeys}
        />
        {query ? (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear the search"
            onClick={() => {
              setQuery('')
              search.current?.focus()
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : (
          <kbd className={styles.searchKeys} aria-hidden="true">
            {shortcutText('switch-conversation')}
          </kbd>
        )}
      </div>
      {problem ? (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      ) : null}
      <div className={styles.scroll}>
        {shelves.map((shelf) => (
          <section key={shelf.id} aria-labelledby={`${id}-${shelf.id}`}>
            <h3 className={styles.shelf} id={`${id}-${shelf.id}`}>
              {shelf.label}
              {shelf.id === 'needs-you' ? (
                <span className={styles.shelfCount}>{shelf.conversations.length}</span>
              ) : null}
            </h3>
            <ul className={styles.rows}>
              {shelf.conversations.map((conversation) => {
                const status = rowStatus(conversation, now, {
                  requests: waiting.filter((r) => r.conversationId === conversation.id),
                  finished: finished.get(conversation.id),
                })
                const StatusIcon = statusIcons[status.kind]
                return (
                  <li key={conversation.id}>
                    {renaming === conversation.id ? (
                      <RenameField
                        conversation={conversation}
                        draft={renameDrafts.get(conversation.id)}
                        onDraft={(value) =>
                          setRenameDrafts((current) =>
                            new Map(current).set(conversation.id, value),
                          )
                        }
                        onDone={() => {
                          setRenameDrafts((current) => {
                            const next = new Map(current)
                            next.delete(conversation.id)
                            return next
                          })
                          setRenaming(undefined)
                          requestAnimationFrame(() => focusRow(conversation.id))
                        }}
                      />
                    ) : (
                      <button
                        ref={(el) => {
                          rows.current.set(conversation.id, el)
                        }}
                        type="button"
                        className={styles.row}
                        aria-current={conversation.id === currentId ? 'page' : undefined}
                        tabIndex={conversation.id === tabStop ? 0 : -1}
                        // Named by what it shows ("Today 2 need you"), with
                        // what the pin means as its description.
                        aria-describedby={
                          conversation.kind === 'main' ? `${id}-main` : undefined
                        }
                        data-attention={
                          status.kind === 'time' ||
                          status.kind === 'none' ||
                          status.kind === 'working'
                            ? undefined
                            : 'true'
                        }
                        title={conversation.preview}
                        onClick={(event) => {
                          // Picked with the pointer, it opens ready to write in, as
                          // in T3 Code. From the keyboard (Enter, Space) focus stays
                          // here, to go on through the list.
                          if (event.detail > 0) {
                            if (conversation.id === currentId) onCompose()
                            else noteCompose()
                          }
                          open(conversation.id)
                        }}
                        onDoubleClick={() => {
                          if (canRename) setRenaming(conversation.id)
                        }}
                        onFocus={() => {
                          setFocusedId(conversation.id)
                          holding.current = conversation.id
                        }}
                        onBlur={() => {
                          holding.current = undefined
                        }}
                        onKeyDown={(event) => rowKeys(event, conversation)}
                      >
                        {conversation.kind === 'main' ? (
                          <Pin size={13} aria-hidden="true" className={styles.pin} />
                        ) : null}
                        <span className={styles.rowTitle}>{conversation.title}</span>
                        {status.label ? (
                          <span className={styles.rowStatus} data-kind={status.kind}>
                            {StatusIcon ? (
                              <StatusIcon size={12} aria-hidden="true" />
                            ) : null}
                            {status.spoken ? (
                              <>
                                <span aria-hidden="true">{status.label}</span>
                                <span className="visually-hidden">{status.spoken}</span>
                              </>
                            ) : (
                              status.label
                            )}
                          </span>
                        ) : null}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        <span id={`${id}-main`} hidden>
          Main conversation
        </span>
        {!flat.length ? (
          <p className={styles.empty}>
            {query ? 'No conversations match.' : 'No conversations yet.'}
          </p>
        ) : null}
      </div>
      {/* The list's edge: drag, or arrow keys, to resize; a double click resets it. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the conversation list"
        aria-valuemin={LIST_WIDTH.min}
        aria-valuemax={LIST_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize; double-click to reset"
        className={styles.resize}
        onPointerDown={startDrag}
        onDoubleClick={() => setSavedWidth(LIST_WIDTH.initial)}
        onKeyDown={(event) => {
          const to =
            event.key === 'ArrowLeft'
              ? width - 16
              : event.key === 'ArrowRight'
                ? width + 16
                : event.key === 'Home'
                  ? LIST_WIDTH.min
                  : event.key === 'End'
                    ? LIST_WIDTH.max
                    : undefined
          if (to === undefined) return
          event.preventDefault()
          setSavedWidth(clamp(to))
        }}
      />
    </nav>
  )
})

/** Renaming in place: Enter saves, Escape keeps the old name, leaving the field saves. */
function RenameField({
  conversation,
  draft,
  onDraft,
  onDone,
}: {
  conversation: Conversation
  /** What was typed before this field was put back (its row moved). */
  draft: string | undefined
  onDraft: (value: string) => void
  onDone: () => void
}) {
  const api = useCindlApi()
  const [value, setValueNow] = useState(draft ?? conversation.title)
  const setValue = (next: string) => {
    setValueNow(next)
    onDraft(next)
  }
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const settled = useRef(false)
  const save = async () => {
    if (settled.current || saving) return
    const title = value.trim()
    if (!title || title === conversation.title) {
      settled.current = true
      onDone()
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await api.call('conversations.rename', { conversationId: conversation.id, title })
      settled.current = true
      onDone()
    } catch (err) {
      setError(isCindlError(err) ? err.message : 'The conversation was not renamed.')
      setSaving(false)
    }
  }
  return (
    <div className={styles.renaming}>
      <input
        className={styles.renameInput}
        aria-label={`Rename ${conversation.title}`}
        value={value}
        maxLength={200}
        disabled={saving}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void save()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            settled.current = true
            onDone()
          }
        }}
      />
      {error ? (
        <p className={styles.problem} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
