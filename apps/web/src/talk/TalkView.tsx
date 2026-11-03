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
import { ArrowDown, ChevronDown, PanelRight, Plus } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { usePreference } from '../platform/preferences.ts'
import { useMediaQuery } from '../platform/useMediaQuery.ts'
import { Overlay } from '../shell/Overlay.tsx'
import { navigate } from '../router.ts'
import { Button, Dot } from '../ui/primitives.tsx'
import { Composer, type ComposerHandle } from './Composer.tsx'
import { HistoryPopover } from './HistoryPopover.tsx'
import { MessageView } from './MessageView.tsx'
import { composerHint, presenceCopy } from './presence.ts'
import { RequestCard } from './RequestCard.tsx'
import { WorkingMargin } from './WorkingMargin.tsx'
import styles from './talk.module.css'

export const AGENT_NAME = 'Hermes'
const BOTTOM_SLACK_PX = 48

export interface TalkHandle {
  focusComposer(): void
  openHistory(): void
  newSideConversation(): void
}

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
    const uncertain = useUncertainPrompts(conversationId)
    const [historyOpen, setHistoryOpen] = useState(false)
    const [marginPreference, setMarginPreference] = usePreference('marginOpen')
    // Wide screens keep the margin as a column (remembered); narrower screens show it
    // as a modal sheet that starts closed, so it never covers live controls.
    const wide = useMediaQuery('(min-width: 1280px)')
    const [sheetOpen, setSheetOpen] = useState(false)
    const marginOpen = wide ? marginPreference : sheetOpen
    const setMarginOpen = wide ? setMarginPreference : setSheetOpen
    const [selection, setSelection] = useState<{
      conversationId: string
      toolId: string
    }>()
    // Pinned to the newest content until the owner scrolls up to read.
    const [atBottom, setAtBottom] = useState(true)
    const composer = useRef<ComposerHandle>(null)
    const scroller = useRef<HTMLDivElement>(null)
    const requested = useRef(new Set<string>())
    const loaded = useCindlState((state) =>
      conversationId ? conversationId in state.messages : true,
    )

    useImperativeHandle(ref, () => ({
      focusComposer: () => composer.current?.focus(),
      openHistory: () => setHistoryOpen(true),
      newSideConversation: async () => {
        if (!canCreate) return
        const created = await api.call('conversations.create', {})
        navigate({ view: 'talk', conversationId: created.id })
      },
    }))

    useEffect(() => {
      if (!conversationId || loaded || requested.current.has(conversationId)) return
      requested.current.add(conversationId)
      void api
        .call('conversations.history', { conversationId })
        .catch(() => requested.current.delete(conversationId))
    }, [api, conversationId, loaded])

    useLayoutEffect(() => {
      const el = scroller.current
      if (el && atBottom) el.scrollTop = el.scrollHeight
    })

    if (!conversationId || !conversation) {
      return (
        <div className={styles.emptyTalk}>
          <p>No conversations yet.</p>
          <Button
            variant="primary"
            onClick={() =>
              void (async () => {
                const created = await api.call('conversations.create', { title: 'Main' })
                await api.call('conversations.setMain', { conversationId: created.id })
                navigate({ view: 'talk', conversationId: created.id })
              })()
            }
          >
            Start a conversation
          </Button>
        </div>
      )
    }

    const presence = presenceCopy(link, activity)
    // Selection belongs to one conversation; switching conversations clears it without an effect.
    const selectedToolId =
      selection?.conversationId === conversationId ? selection.toolId : undefined
    const selectTool = (toolId: string) => {
      setSelection(selectedToolId === toolId ? undefined : { conversationId, toolId })
      setMarginOpen(true)
    }
    const startSide = async () => {
      const created = await api.call('conversations.create', {})
      navigate({ view: 'talk', conversationId: created.id })
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
          <header className={styles.header}>
            <button
              type="button"
              className={styles.switcher}
              onClick={() => setHistoryOpen(true)}
              aria-haspopup="dialog"
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
              {canCreate ? (
                <Button
                  variant="quiet"
                  icon
                  aria-label="New side conversation"
                  title="New side conversation"
                  onClick={() => void startSide()}
                >
                  <Plus size={18} aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                variant="quiet"
                icon
                aria-label={
                  marginOpen ? 'Hide the working margin' : 'Show the working margin'
                }
                aria-pressed={marginOpen}
                title="Working margin"
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
              }}
            >
              <div
                className={styles.measure}
                role="log"
                aria-label="Messages"
                aria-live="off"
              >
                {!loaded ? <p className={styles.loading}>Loading conversation…</p> : null}
                {messages.map((message) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    agentName={AGENT_NAME}
                    selectedToolId={selectedToolId}
                    blockedToolIds={activity.blockedToolIds}
                    onSelectTool={selectTool}
                  />
                ))}
                {activity.openRequests.map((request) => (
                  <RequestCard key={request.requestId} request={request} />
                ))}
              </div>
            </div>
            {!atBottom ? (
              <Button
                className={styles.jump}
                onClick={jumpToLatest}
                aria-label="Jump to latest messages"
              >
                <ArrowDown size={15} aria-hidden="true" /> Latest
              </Button>
            ) : null}
          </div>
          <div className={styles.composerDock}>
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
            selectedToolId={selectedToolId}
            onClearSelection={() => setSelection(undefined)}
            onClose={() => setMarginOpen(false)}
          />
        ) : null}
        {!wide ? (
          <Overlay
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            label="Working margin"
            placement="sheet"
          >
            <WorkingMargin
              conversationId={conversationId}
              selectedToolId={selectedToolId}
              onClearSelection={() => setSelection(undefined)}
              onClose={() => setSheetOpen(false)}
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
