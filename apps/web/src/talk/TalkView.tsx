import {
  useCindlApi,
  useConversation,
  useConversations,
  useLink,
  useMainConversation,
  useMessages,
  useOpenRequests,
  useCindlState,
} from '@cindl/client-react'
import { ChevronDown, PanelRight, Plus } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { navigate } from '../router.ts'
import { linkCopy } from '../shell/LinkStatus.tsx'
import { usePreference } from '../platform/preferences.ts'
import { Button, Dot } from '../ui/primitives.tsx'
import { Composer, type ComposerHandle } from './Composer.tsx'
import { HistoryPopover } from './HistoryPopover.tsx'
import { MessageView } from './MessageView.tsx'
import { RequestCard } from './RequestCard.tsx'
import { WorkingMargin } from './WorkingMargin.tsx'
import styles from './talk.module.css'

export const AGENT_NAME = 'Hermes'

export interface TalkHandle {
  focusComposer(): void
  openHistory(): void
  newSideConversation(): void
}

function usePresence(conversationId: string | undefined) {
  const link = useLink()
  const conversation = useConversation(conversationId)
  const requests = useOpenRequests(conversationId)
  const runningTitle = useCindlState((state) => {
    const running = Object.values(state.tools).filter(
      (t) =>
        t.conversationId === conversationId &&
        (t.status === 'running' || t.status === 'generating'),
    )
    return running.at(-1)?.title
  })
  if (link.phase !== 'online' && !link.demo)
    return {
      tone: linkCopy(link.phase, false).tone,
      text: linkCopy(link.phase, false).label,
    }
  if (requests.length) {
    const approvals = requests.filter((r) => r.kind === 'approval').length
    const questions = requests.length - approvals
    const parts = [
      approvals ? `${approvals} approval${approvals > 1 ? 's' : ''}` : '',
      questions ? `${questions} question${questions > 1 ? 's' : ''}` : '',
    ].filter(Boolean)
    return { tone: 'accent' as const, text: `Waiting on you: ${parts.join(', ')}` }
  }
  if (runningTitle) return { tone: 'info' as const, text: `Working: ${runningTitle}` }
  if (conversation?.status === 'working')
    return { tone: 'info' as const, text: 'Working' }
  if (conversation?.status === 'unknown')
    return { tone: 'neutral' as const, text: 'Status unknown' }
  return { tone: 'neutral' as const, text: 'Idle' }
}

export const TalkView = forwardRef<TalkHandle, { conversationId: string | undefined }>(
  function TalkView({ conversationId: requestedId }, ref) {
    const api = useCindlApi()
    const conversations = useConversations()
    const main = useMainConversation()
    const conversationId = requestedId ?? main?.id ?? conversations[0]?.id
    const conversation = useConversation(conversationId)
    const messages = useMessages(conversationId)
    const requests = useOpenRequests(conversationId)
    const presence = usePresence(conversationId)
    const [historyOpen, setHistoryOpen] = useState(false)
    const [marginOpen, setMarginOpen] = usePreference('marginOpen')
    const [selection, setSelection] = useState<{
      conversationId: string
      toolId: string
    }>()
    const composer = useRef<ComposerHandle>(null)
    const scroller = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const requested = useRef(new Set<string>())
    const loaded = useCindlState((state) =>
      conversationId ? conversationId in state.messages : true,
    )

    useImperativeHandle(ref, () => ({
      focusComposer: () => composer.current?.focus(),
      openHistory: () => setHistoryOpen(true),
      newSideConversation: async () => {
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

    // Stay pinned to the newest content unless the owner scrolled up to read.
    useLayoutEffect(() => {
      const el = scroller.current
      if (el && stick.current) el.scrollTop = el.scrollHeight
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

    const working =
      conversation.status === 'working' || messages.some((m) => m.status === 'streaming')
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

    return (
      <div className={styles.talk} data-margin={marginOpen ? 'open' : 'closed'}>
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
            </p>
            <div className={styles.headerActions}>
              <Button
                variant="quiet"
                icon
                aria-label="New side conversation"
                title="New side conversation"
                onClick={() => void startSide()}
              >
                <Plus size={18} aria-hidden="true" />
              </Button>
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
          <div
            ref={scroller}
            className={styles.timeline}
            onScroll={(event) => {
              const el = event.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
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
                  onSelectTool={selectTool}
                />
              ))}
              {requests.map((request) => (
                <RequestCard
                  key={`${request.connectionEpoch}:${request.rpcId}`}
                  request={request}
                />
              ))}
            </div>
          </div>
          <div className={styles.composerDock}>
            <Composer
              ref={composer}
              conversationId={conversationId}
              working={working}
              agentName={AGENT_NAME}
            />
          </div>
        </section>
        {marginOpen ? (
          <WorkingMargin
            conversationId={conversationId}
            selectedToolId={selectedToolId}
            onClearSelection={() => setSelection(undefined)}
            onClose={() => setMarginOpen(false)}
          />
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
