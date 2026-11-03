import { hasEntry } from '@cindl/client-core'
import {
  useCan,
  useCindlApi,
  useCindlState,
  useConversation,
  useConversationActivity,
  useConversations,
  useLink,
  useMainConversation,
  useMessages,
  useUncertainPrompts,
} from '@cindl/client-react'
import { isCindlError } from '@cindl/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View, type ScrollViewInstance } from 'react-native'
import { useNav, useNavigate } from '../nav/NavProvider.tsx'
import { useTheme } from '../theme/theme.tsx'
import { ArrowDown, ChevronDown, PanelBottom, Plus } from '../ui/icons.ts'
import { Button, Dot, ErrorText, focusRing, Txt } from '../ui/primitives.tsx'
import { Composer } from './Composer.tsx'
import { HistorySheet } from './HistorySheet.tsx'
import { MessageView } from './MessageView.tsx'
import { composerHint, presenceCopy } from './presence.ts'
import { RequestCard } from './RequestCard.tsx'
import { requestKeyOf } from './requests.ts'
import { WorkingMargin } from './WorkingMargin.tsx'

export const AGENT_NAME = 'Hermes'

/** Distance from the end (dp) within which the timeline keeps following new output. */
const STICK_THRESHOLD = 48

const failureText = (error: unknown, fallback: string) =>
  isCindlError(error) ? error.message : fallback

export function TalkView() {
  const api = useCindlApi()
  const theme = useTheme()
  const nav = useNav()
  const navigate = useNavigate()
  const link = useLink()
  const conversations = useConversations()
  const main = useMainConversation()
  // A side conversation that is gone (or never was on this connection) is said so, not swapped.
  const missing =
    nav.conversationId !== undefined &&
    conversations.length > 0 &&
    !conversations.some((c) => c.id === nav.conversationId)
  const conversationId = missing
    ? undefined
    : (nav.conversationId ?? main?.id ?? conversations[0]?.id)
  const conversation = useConversation(conversationId)
  const messages = useMessages(conversationId)
  const activity = useConversationActivity(conversationId)
  const uncertain = useUncertainPrompts(conversationId)
  const canCreate = useCan('sessions.create')
  const canHistory = useCan('sessions.history')
  const loaded = useCindlState((state) =>
    conversationId ? hasEntry(state.messages, conversationId) : true,
  )
  const [historyOpen, setHistoryOpen] = useState(false)
  const [marginOpen, setMarginOpen] = useState(false)
  const [selection, setSelection] = useState<{ conversationId: string; toolId: string }>()
  const [problem, setProblem] = useState<string>()
  const [historyError, setHistoryError] = useState<{ id: string; message: string }>()
  const [switcherFocused, setSwitcherFocused] = useState(false)
  const [atEnd, setAtEnd] = useState(true)
  const [focusRequestId, setFocusRequestId] = useState<string>()
  const scroller = useRef<ScrollViewInstance>(null)
  const stick = useRef(true)
  const offsets = useRef(new Map<string, { y: number; stick: boolean }>())
  const cardOffsets = useRef(new Map<string, number>())
  const restoredFor = useRef<string | undefined>(undefined)
  // In-flight history loads. After `history.reset` the transcript is missing
  // again and, with nothing in flight, it is fetched again.
  const inflight = useRef(new Set<string>())
  const historyFailed = historyError?.id === conversationId

  // History is a gated read: only fetched once `sessions.history` is usable.
  useEffect(() => {
    if (!conversationId || !conversation || loaded || !canHistory || historyFailed) return
    if (inflight.current.has(conversationId)) return
    inflight.current.add(conversationId)
    api.call('conversations.history', { conversationId }).then(
      () => inflight.current.delete(conversationId),
      (error: unknown) => {
        inflight.current.delete(conversationId)
        setHistoryError({
          id: conversationId,
          message: failureText(error, 'The conversation could not be loaded.'),
        })
      },
    )
  }, [api, conversationId, conversation, loaded, canHistory, historyFailed])

  const openConversation = useCallback(
    (id: string) =>
      navigate({
        type: 'conversation',
        conversationId: id === main?.id ? undefined : id,
      }),
    [navigate, main?.id],
  )
  const clearFocusRequest = useCallback(() => setFocusRequestId(undefined), [])

  const startSide = () => {
    setProblem(undefined)
    api.call('conversations.create', {}).then(
      (created) => openConversation(created.id),
      (error: unknown) =>
        setProblem(failureText(error, 'The side conversation could not be started.')),
    )
  }

  if (missing)
    return (
      <View
        accessibilityLiveRegion="polite"
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space[3],
          padding: theme.space[6],
        }}
      >
        <Txt tone="tertiary">This conversation is not available on this connection.</Txt>
        <Button
          label="Open the main conversation"
          variant="primary"
          onPress={() => navigate({ type: 'conversation', conversationId: undefined })}
        />
      </View>
    )

  if (!conversationId || !conversation) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space[3],
          padding: theme.space[6],
        }}
      >
        <Txt tone="tertiary">No conversations yet.</Txt>
        {canCreate ? (
          <Button
            label="Start a conversation"
            variant="primary"
            onPress={() => {
              setProblem(undefined)
              void (async () => {
                try {
                  const created = await api.call('conversations.create', {
                    title: 'Main',
                  })
                  await api.call('conversations.setMain', { conversationId: created.id })
                  openConversation(created.id)
                } catch (error) {
                  setProblem(failureText(error, 'The conversation could not be started.'))
                }
              })()
            }}
          />
        ) : (
          <Txt tone="tertiary">
            Starting conversations is not available on this connection.
          </Txt>
        )}
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </View>
    )
  }

  const presence = presenceCopy(link, activity)
  const selectedToolId =
    selection?.conversationId === conversationId ? selection.toolId : undefined
  const showRequest = (requestId: string) => {
    setMarginOpen(false)
    const y = cardOffsets.current.get(requestId)
    if (y !== undefined) {
      stick.current = false
      scroller.current?.scrollTo({ y: Math.max(0, y - theme.space[4]), animated: false })
    }
    setFocusRequestId(requestId)
  }
  const jumpToLatest = () => {
    stick.current = true
    setAtEnd(true)
    scroller.current?.scrollToEnd({ animated: false })
  }

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          gap: theme.space[1],
          padding: theme.space[2],
          borderBottomWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[1] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${conversation.title}${
              conversation.kind === 'main' ? ', Main' : ''
            }. Switch conversation`}
            onPress={() => setHistoryOpen(true)}
            onFocus={() => setSwitcherFocused(true)}
            onBlur={() => setSwitcherFocused(false)}
            android_ripple={{ color: theme.colors.selection }}
            style={[
              {
                flexShrink: 1,
                minHeight: theme.layout.touchTarget,
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space[2],
                paddingHorizontal: theme.space[2],
                borderRadius: theme.radius.md,
              },
              switcherFocused ? focusRing(theme) : null,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[theme.text.title, { flexShrink: 1, color: theme.colors.text }]}
            >
              {conversation.title}
            </Text>
            {conversation.kind === 'main' ? (
              <View
                style={{
                  paddingHorizontal: theme.space[1.5],
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.accentSubtle,
                }}
              >
                <Text
                  style={[
                    theme.text.caption,
                    { fontFamily: theme.fonts.semibold, color: theme.colors.accentText },
                  ]}
                >
                  Main
                </Text>
              </View>
            ) : null}
            <ChevronDown
              size={16}
              color={theme.colors.textSecondary}
              strokeWidth={1.75}
            />
          </Pressable>
          <View style={{ flex: 1 }} />
          {canCreate ? (
            <Button
              label="New side conversation"
              icon={Plus}
              iconOnly
              variant="quiet"
              onPress={startSide}
            />
          ) : null}
          <Button
            label="Show the working margin"
            icon={PanelBottom}
            iconOnly
            variant="quiet"
            onPress={() => setMarginOpen(true)}
          />
        </View>
        <View
          accessibilityLiveRegion="polite"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            columnGap: theme.space[2],
            paddingHorizontal: theme.space[2],
          }}
        >
          <Dot tone={presence.tone} />
          <Text
            style={[
              theme.text.label,
              { flexShrink: 1, color: theme.colors.textSecondary },
            ]}
          >
            {presence.text}
          </Text>
          {presence.aside ? (
            <Text style={[theme.text.label, { color: theme.colors.textTertiary }]}>
              {presence.aside}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <ScrollView
          key={conversationId}
          ref={scroller}
          style={{ flex: 1 }}
          contentContainerStyle={{
            gap: theme.space[6],
            paddingHorizontal: theme.space[4],
            paddingTop: theme.space[5],
            paddingBottom: theme.space[4],
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          scrollEventThrottle={100}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
            const end =
              contentSize.height - contentOffset.y - layoutMeasurement.height <
              STICK_THRESHOLD
            stick.current = end
            if (end !== atEnd) setAtEnd(end)
            offsets.current.set(conversationId, { y: contentOffset.y, stick: end })
          }}
          onContentSizeChange={() => {
            const view = scroller.current
            if (!view) return
            // A different conversation remounts the timeline; restore where the owner left it.
            if (restoredFor.current !== conversationId) {
              restoredFor.current = conversationId
              const saved = offsets.current.get(conversationId)
              if (saved && !saved.stick) {
                stick.current = false
                setAtEnd(false)
                view.scrollTo({ y: saved.y, animated: false })
                return
              }
              stick.current = true
            }
            // Follow new output unless the owner scrolled up to read.
            if (stick.current) view.scrollToEnd({ animated: false })
          }}
        >
          {problem ? <ErrorText>{problem}</ErrorText> : null}
          {!loaded && !canHistory ? (
            <Txt tone="tertiary">History is not available on this connection.</Txt>
          ) : !loaded && historyFailed && historyError ? (
            <View style={{ gap: theme.space[2], alignItems: 'flex-start' }}>
              <ErrorText>{historyError.message}</ErrorText>
              <Button
                label="Retry"
                variant="quiet"
                onPress={() => setHistoryError(undefined)}
              />
            </View>
          ) : !loaded ? (
            <Txt tone="tertiary">Loading conversation…</Txt>
          ) : null}
          {messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              agentName={AGENT_NAME}
              selectedToolId={selectedToolId}
              blockedToolIds={activity.blockedToolIds}
              onSelectTool={(toolId) => {
                setSelection({ conversationId, toolId })
                setMarginOpen(true)
              }}
            />
          ))}
          {activity.openRequests.map((request) => (
            <View
              key={requestKeyOf(request)}
              onLayout={(event) =>
                cardOffsets.current.set(request.requestId, event.nativeEvent.layout.y)
              }
            >
              <RequestCard
                request={request}
                focusRequested={focusRequestId === request.requestId}
                onFocused={clearFocusRequest}
              />
            </View>
          ))}
        </ScrollView>
        {!atEnd ? (
          <View
            style={{
              position: 'absolute',
              right: theme.space[3],
              bottom: theme.space[3],
            }}
          >
            <Button
              label="Latest"
              accessibilityLabel="Jump to latest messages"
              icon={ArrowDown}
              onPress={jumpToLatest}
              style={{ boxShadow: theme.shadow.overlay }}
            />
          </View>
        ) : null}
      </View>
      <View
        style={{
          gap: theme.space[2],
          paddingHorizontal: theme.space[3],
          paddingTop: theme.space[2],
          paddingBottom: theme.space[3],
        }}
      >
        {uncertain.map((prompt) => (
          <View
            key={prompt.clientId}
            accessibilityLiveRegion="polite"
            style={{
              gap: theme.space[1],
              padding: theme.space[3],
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.warningSubtle,
            }}
          >
            <Txt variant="label" tone="warning">
              {`Not confirmed: “${
                prompt.text.length > 60 ? `${prompt.text.slice(0, 60)}…` : prompt.text
              }”. Hermes may or may not have received it. Check the conversation before sending again.`}
            </Txt>
            <Button
              label="Dismiss"
              variant="quiet"
              style={{ alignSelf: 'flex-end' }}
              onPress={() =>
                void api
                  .call('prompt.discard', { clientId: prompt.clientId })
                  .catch(() => {
                    // Dismissing only drops local state; on failure the notice simply stays.
                  })
              }
            />
          </View>
        ))}
        <Composer
          conversationId={conversationId}
          canStop={activity.turnOpen || activity.phase === 'executing'}
          hint={composerHint(activity)}
          agentName={AGENT_NAME}
        />
      </View>
      <WorkingMargin
        open={marginOpen}
        onClose={() => setMarginOpen(false)}
        conversationId={conversationId}
        selectedToolId={selectedToolId}
        blockedToolIds={activity.blockedToolIds}
        onClearSelection={() => setSelection(undefined)}
        onShowRequest={showRequest}
      />
      <HistorySheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        currentId={conversationId}
        onOpenConversation={openConversation}
      />
    </View>
  )
}
