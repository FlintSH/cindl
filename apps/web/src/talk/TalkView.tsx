import {
  useCindlApi,
  useCindlState,
  useConversation,
  useConversationActivity,
  useConversations,
  useCan,
  useLink,
  useMainConversation,
  useMessages,
  useUncertainPrompts,
} from '@cindl/client-react'
import { ArrowDown, ChevronDown, PanelLeftOpen, PanelRight, Plus } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { hasEntry } from '@cindl/client-core'
import { isCindlError, type ServerRequest } from '@cindl/contracts'
import { usePreference } from '../platform/preferences.ts'
import { useMediaQuery } from '../platform/useMediaQuery.ts'
import { Overlay } from '../shell/Overlay.tsx'
import { navigate } from '../router.ts'
import { matchShortcut, shortcutText } from '../shortcuts.ts'
import { Button, Dot } from '../ui/primitives.tsx'
import { Composer, type ComposerHandle } from './Composer.tsx'
import { HistoryPopover } from './HistoryPopover.tsx'
import { MessageView, turnStateOf } from './MessageView.tsx'
import {
  keepPlace,
  noteFresh,
  placeOf,
  takeFresh,
  takeSwitch,
  useSelectedStep,
} from './places.ts'
import { composerHint, presenceCopy } from './presence.ts'
import { RequestCard, requestDomId } from './RequestCard.tsx'
import { WorkingMargin } from './WorkingMargin.tsx'
import styles from './talk.module.css'

export const AGENT_NAME = 'Hermes'
const BOTTOM_SLACK_PX = 48

export interface TalkHandle {
  focusComposer(): void
  openHistory(): void
  newSideConversation(): void
  toggleMargin(): void
}

const failureText = (err: unknown, fallback: string) =>
  isCindlError(err) ? err.message : fallback

export const TalkView = forwardRef<TalkHandle, { conversationId: string | undefined }>(
  function TalkView({ conversationId: requestedId }, ref) {
    const api = useCindlApi()
    const link = useLink()
    const conversations = useConversations()
    const main = useMainConversation()
    const conversationId = requestedId ?? main?.id ?? conversations[0]?.id
    const conversation = useConversation(conversationId)
    const messages = useMessages(conversationId)
    const activity = useConversationActivity(conversationId)
    const canCreate = useCan('sessions.create')
    const canHistory = useCan('sessions.history')
    const [problem, setProblem] = useState<string>()
    const [historyError, setHistoryError] = useState<{ id: string; message: string }>()
    const uncertain = useUncertainPrompts(conversationId)
    const [historyOpen, setHistoryOpen] = useState(false)
    const [marginPreference, setMarginPreference] = usePreference('marginOpen')
    const [listOpen, setListOpen] = usePreference('conversationsOpen')
    // Wide screens keep the margin as a column (remembered); narrower screens show it
    // as a modal sheet that starts closed, so it never covers live controls.
    const wide = useMediaQuery('(min-width: 1280px)')
    const roomy = useMediaQuery('(min-width: 768px) and (min-height: 640px)')
    const [sheetOpen, setSheetOpen] = useState(false)
    const marginOpen = wide ? marginPreference : sheetOpen
    const setMarginOpen = wide ? setMarginPreference : setSheetOpen
    // The selected step lives in the conversation's place (places.ts).
    const selectedToolId = useSelectedStep(conversationId)
    // Pinned to the newest content until the owner scrolls up to read.
    const [atBottom, setAtBottom] = useState(
      () => !conversationId || placeOf(conversationId).scrollTop === undefined,
    )
    const composer = useRef<ComposerHandle>(null)
    const scroller = useRef<HTMLDivElement>(null)
    const switcher = useRef<HTMLButtonElement>(null)
    const marginToggle = useRef<HTMLButtonElement>(null)
    // In-flight history loads. After `history.reset` the transcript is missing
    // again and, with nothing in flight, it is fetched again.
    const inflight = useRef(new Set<string>())
    const loaded = useCindlState((state) =>
      conversationId ? hasEntry(state.messages, conversationId) : true,
    )

    useImperativeHandle(ref, () => ({
      focusComposer: () => composer.current?.focus(),
      openHistory: () => setHistoryOpen(true),
      newSideConversation: async () => {
        if (!canCreate) return
        try {
          const created = await api.call('conversations.create', {})
          noteFresh()
          navigate({ view: 'talk', conversationId: created.id })
        } catch (err) {
          setProblem(failureText(err, 'The side conversation could not be started.'))
        }
      },
      toggleMargin: () => {
        // Closing the column with focus inside it: focus goes to what reopens
        // it, as the close button does. Focus elsewhere stays where it is.
        const inside =
          wide &&
          marginOpen &&
          document.activeElement?.closest('[aria-label="Working margin"]') != null
        setMarginOpen(!marginOpen)
        if (inside) marginToggle.current?.focus()
      },
    }))

    const historyFailed = historyError?.id === conversationId
    useEffect(() => {
      if (!conversationId || !conversation || loaded || !canHistory || historyFailed)
        return
      if (inflight.current.has(conversationId)) return
      inflight.current.add(conversationId)
      api.call('conversations.history', { conversationId }).then(
        () => inflight.current.delete(conversationId),
        (err: unknown) => {
          inflight.current.delete(conversationId)
          setHistoryError({
            id: conversationId,
            message: failureText(err, 'The conversation could not be loaded.'),
          })
        },
      )
    }, [api, conversationId, conversation, loaded, canHistory, historyFailed])

    // Chosen from the switcher, the conversation takes focus back to its switcher:
    // the one the owner pressed went with the conversation it belonged to. One
    // Cindl just created opens with focus in its message box, once that is shown.
    const composeOnArrival = useRef(false)
    useEffect(() => {
      const fresh = takeFresh()
      const switched = takeSwitch()
      if (fresh) composeOnArrival.current = true
      else if (switched) switcher.current?.focus()
    }, [conversationId])
    useEffect(() => {
      if (!composeOnArrival.current || !composer.current) return
      composeOnArrival.current = false
      composer.current.focus()
    })

    // Typing on Talk with nothing to type into goes on in the message box, as
    // `/` does. Shortcut keys, Space and keys with Ctrl, Alt or ⌘ keep their jobs.
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing) return
        if (event.ctrlKey || event.metaKey || event.altKey) return
        // Shortcuts keep their keys (the registry decides, not a list here).
        if (event.key.length !== 1 || event.key === ' ' || matchShortcut(event)) return
        const target = event.target
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
        )
          return
        if (document.querySelector('dialog[open]')) return
        composer.current?.focus()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [])

    // Coming back to a conversation puts the owner where they were reading.
    useLayoutEffect(() => {
      const el = scroller.current
      if (!el || !conversationId) return
      const { scrollTop } = placeOf(conversationId)
      if (scrollTop !== undefined) el.scrollTop = scrollTop
      setAtBottom(scrollTop === undefined)
    }, [conversationId, loaded])

    useLayoutEffect(() => {
      const el = scroller.current
      if (el && atBottom) el.scrollTop = el.scrollHeight
    })

    if (requestedId && !conversation && conversations.length) {
      return (
        <div className={styles.emptyTalk} role="status">
          <p>This conversation is not available on this connection.</p>
          <Button variant="primary" onClick={() => navigate({ view: 'talk' })}>
            Open the main conversation
          </Button>
        </div>
      )
    }

    if (!conversationId || !conversation) {
      return (
        <div className={styles.emptyTalk}>
          <p>No conversations yet.</p>
          {canCreate ? (
            <Button
              variant="primary"
              onClick={() =>
                void (async () => {
                  try {
                    const created = await api.call('conversations.create', {
                      title: 'Main',
                    })
                    await api.call('conversations.setMain', {
                      conversationId: created.id,
                    })
                    noteFresh()
                    navigate({ view: 'talk', conversationId: created.id })
                  } catch (err) {
                    setProblem(failureText(err, 'The conversation could not be started.'))
                  }
                })()
              }
            >
              Start a conversation
            </Button>
          ) : (
            <p className={styles.loading}>
              Starting conversations is not available on this connection.
            </p>
          )}
          {problem ? <p role="alert">{problem}</p> : null}
        </div>
      )
    }

    const presence = presenceCopy(link, activity)
    // Docked only where there is room for it and the conversation both: a
    // phone (or a short window) keeps the set in the conversation instead.
    const docked = roomy
      ? activity.openRequests.find((request) => request.kind === 'clarify')
      : undefined
    // The open cards sit at the end of the conversation: below, while the owner reads back.
    const waitingBelow = activity.openRequests.some((r) => r.kind !== 'unsupported')
    // Selection belongs to one conversation and comes back with it. Selecting
    // a step opens the working margin on Step; selecting it again clears it
    // and leaves the margin's tool as it is, as "Clear the step" does.
    const selectTool = (toolId: string) => {
      const next = selectedToolId === toolId ? undefined : toolId
      keepPlace(
        conversationId,
        next ? { toolId: next, tool: 'step' } : { toolId: undefined },
      )
      if (next) setMarginOpen(true)
    }
    const startSide = async () => {
      try {
        const created = await api.call('conversations.create', {})
        noteFresh()
        navigate({ view: 'talk', conversationId: created.id })
      } catch (err) {
        setProblem(failureText(err, 'The side conversation could not be started.'))
      }
    }
    const revealRequest = (request: ServerRequest) => {
      const go = () => {
        const card = document.getElementById(requestDomId(request))
        card?.scrollIntoView({ block: 'center' })
        card?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })
      }
      if (wide) return go()
      // Below 1280px the margin is a modal sheet and everything behind it is
      // inert, so close it first, then reveal and focus the card.
      setSheetOpen(false)
      requestAnimationFrame(() => requestAnimationFrame(go))
    }
    const jumpToLatest = () => {
      const el = scroller.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      setAtBottom(true)
    }

    return (
      <div className={styles.talk} data-margin={wide && marginOpen ? 'open' : 'closed'}>
        <section
          className={styles.conversation}
          aria-label={`Conversation: ${conversation.title}`}
        >
          <header
            className={styles.header}
            data-list={wide && !listOpen ? 'hidden' : undefined}
          >
            {wide && !listOpen ? (
              <Button
                variant="quiet"
                icon
                data-show-conversations
                aria-label="Show the conversation list"
                title={`Show conversations (${shortcutText('toggle-conversations')})`}
                onClick={() => setListOpen(true)}
              >
                <PanelLeftOpen size={18} aria-hidden="true" />
              </Button>
            ) : null}
            <button
              ref={switcher}
              type="button"
              className={styles.switcher}
              onClick={() => setHistoryOpen(true)}
              aria-haspopup="dialog"
              title={`Switch conversation (${shortcutText('switch-conversation')})`}
            >
              <span className={styles.switcherTitle}>{conversation.title}</span>
              {conversation.kind === 'main' ? (
                <span className={styles.mainTag}>Main</span>
              ) : null}
              <ChevronDown size={16} aria-hidden="true" />
              <span className="visually-hidden">Switch conversation</span>
            </button>
            <p className={styles.presence} role="status">
              <Dot tone={presence.tone} />
              <span>{presence.text}</span>
              {presence.aside ? (
                <span className={styles.presenceAside}>{presence.aside}</span>
              ) : null}
            </p>
            <div className={styles.headerActions}>
              {/* With the conversation list shown, its own new-conversation button stands in. */}
              {canCreate && !(wide && listOpen) ? (
                <Button
                  variant="quiet"
                  icon
                  aria-label="New side conversation"
                  title={`New side conversation (${shortcutText('new-side')})`}
                  onClick={() => void startSide()}
                >
                  <Plus size={18} aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                ref={marginToggle}
                variant="quiet"
                icon
                aria-label={
                  marginOpen ? 'Hide the working margin' : 'Show the working margin'
                }
                aria-pressed={marginOpen}
                title={`${marginOpen ? 'Hide' : 'Show'} the working margin (${shortcutText('toggle-margin')})`}
                onClick={() => setMarginOpen(!marginOpen)}
              >
                <PanelRight size={18} aria-hidden="true" />
              </Button>
            </div>
          </header>
          <div className={styles.timelineWrap}>
            <div
              ref={scroller}
              className={styles.timeline}
              onScroll={(event) => {
                const el = event.currentTarget
                const bottom =
                  el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX
                if (bottom !== atBottom) setAtBottom(bottom)
                keepPlace(conversationId, {
                  scrollTop: bottom ? undefined : el.scrollTop,
                })
              }}
            >
              <div
                className={styles.measure}
                role="log"
                aria-label="Messages"
                aria-live="off"
              >
                {problem ? (
                  <p className={styles.notice} data-level="error" role="alert">
                    {problem}
                  </p>
                ) : null}
                {!loaded && !canHistory ? (
                  <p className={styles.loading}>
                    History is not available on this connection.
                  </p>
                ) : !loaded && historyFailed ? (
                  <div className={styles.notice} data-level="error" role="alert">
                    {historyError?.message}{' '}
                    <Button variant="quiet" onClick={() => setHistoryError(undefined)}>
                      Retry
                    </Button>
                  </div>
                ) : !loaded ? (
                  <p className={styles.loading}>Loading conversation…</p>
                ) : null}
                {messages.map((message) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    agentName={AGENT_NAME}
                    selectedToolId={selectedToolId}
                    blockedToolIds={activity.blockedToolIds}
                    onSelectTool={selectTool}
                    turn={
                      message.status === 'streaming'
                        ? turnStateOf(activity.phase)
                        : undefined
                    }
                  />
                ))}
                {activity.openRequests
                  .filter((request) => request !== docked)
                  .map((request) => (
                    <RequestCard key={request.requestId} request={request} />
                  ))}
                {loaded && !messages.length && !activity.openRequests.length ? (
                  <p className={styles.emptyConversation}>
                    {conversation.kind === 'main'
                      ? 'Nothing here yet.'
                      : 'Nothing here yet. This side conversation runs apart from the main one.'}
                  </p>
                ) : null}
              </div>
            </div>
            {!atBottom ? (
              <Button
                className={styles.jump}
                // A press never takes focus (the pill goes away as it lands);
                // from the keyboard, focus goes on to the message box.
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  const pill = event.currentTarget
                  const fromKeyboard = document.activeElement === pill
                  jumpToLatest()
                  if (!fromKeyboard) return
                  composer.current?.focus()
                  // A disabled message box (offline) takes no focus: the
                  // switcher does, so focus never falls to the page.
                  if (document.activeElement === pill) switcher.current?.focus()
                }}
                aria-label={
                  waitingBelow
                    ? 'Jump to latest messages, where Hermes waits on you'
                    : 'Jump to latest messages'
                }
              >
                <ArrowDown size={15} aria-hidden="true" /> Latest
                {waitingBelow ? (
                  <span className={styles.jumpNote} aria-hidden="true">
                    Needs you
                  </span>
                ) : null}
              </Button>
            ) : null}
          </div>
          <div className={styles.composerDock}>
            {docked ? (
              // The oldest question set waits right where the owner types (after
              // T3 Code's pending-input panel); approvals stay in the conversation.
              <div className={styles.dock}>
                <RequestCard key={docked.requestId} request={docked} layout="dock" />
              </div>
            ) : null}
            {uncertain.map((prompt) => (
              <div key={prompt.clientId} className={styles.uncertain} role="status">
                <p>
                  Not confirmed: “
                  {prompt.text.length > 60 ? `${prompt.text.slice(0, 60)}…` : prompt.text}
                  ”. Hermes may or may not have received it. Check the conversation before
                  sending again.
                </p>
                <Button
                  variant="quiet"
                  onClick={() =>
                    void api.call('prompt.discard', { clientId: prompt.clientId })
                  }
                >
                  Dismiss
                </Button>
              </div>
            ))}
            <Composer
              key={conversationId}
              ref={composer}
              conversationId={conversationId}
              canStop={activity.turnOpen || activity.phase === 'executing'}
              hint={composerHint(activity)}
              agentName={AGENT_NAME}
            />
          </div>
        </section>
        {wide && marginOpen ? (
          <WorkingMargin
            conversationId={conversationId}
            onClose={() => {
              setMarginOpen(false)
              // The close button goes with the margin: focus goes to what reopens it.
              marginToggle.current?.focus()
            }}
            onShowRequest={revealRequest}
          />
        ) : null}
        {!wide ? (
          <Overlay
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            label="Working margin"
            placement="sheet"
            initialFocus={'[role="tab"][aria-selected="true"]'}
          >
            <WorkingMargin
              conversationId={conversationId}
              onClose={() => setSheetOpen(false)}
              onShowRequest={revealRequest}
            />
          </Overlay>
        ) : null}
        <HistoryPopover
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          currentId={conversationId}
        />
      </div>
    )
  },
)
