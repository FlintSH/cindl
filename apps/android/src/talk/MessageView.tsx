import type { Message } from '@cindl/contracts'
import { memo, useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Markdown } from '../markdown/Markdown.tsx'
import { useTheme } from '../theme/theme.tsx'
import { ChevronDown, ChevronRight } from '../ui/icons.ts'
import { Press, Txt } from '../ui/primitives.tsx'
import { elapsed, messageTime, momentInSentence } from './format.ts'
import { ToolRow } from './ToolRow.tsx'
import { WorkGroup } from './WorkGroup.tsx'
import { segmentsOf } from './workGroups.ts'

/** While a reply streams, its header counts up from when it started (web parity). */
function Working({ since }: { since: string | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])
  const took = elapsed(since, now)
  return (
    <Txt variant="label" tone="tertiary" style={{ fontVariant: ['tabular-nums'] }}>
      {took ? `Working for ${took}` : 'Working…'}
    </Txt>
  )
}

const originNote: Partial<Record<NonNullable<Message['origin']>, string>> = {
  routine: 'From a routine',
  proactive: 'Unprompted',
}

/**
 * What a streaming reply's header says, from the conversation's observed
 * phase (web parity): counting while Hermes works, "Waiting for you" while it
 * is blocked on the owner, just its time when Cindl cannot tell.
 */
export type TurnState = 'working' | 'waiting' | undefined

export function turnStateOf(phase: string): TurnState {
  if (phase === 'waiting-on-you') return 'waiting'
  return phase === 'executing' || phase === 'queued' ? 'working' : undefined
}

/** Owner messages are compact right-aligned bubbles; Hermes replies are full-width reading blocks. */
export const MessageView = memo(function MessageView({
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
  const theme = useTheme()
  const time = messageTime(message.createdAt)
  // Spoken: "You, today at 8:03 AM" (web parity).
  const moment = momentInSentence(message.createdAt)
  if (message.role === 'user') {
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
    return (
      <View style={{ alignItems: 'flex-end' }}>
        <View
          accessible
          accessibilityLabel={`You${moment ? `, ${moment}` : ''}: ${text}`}
          style={{
            maxWidth: '85%',
            paddingVertical: theme.space[2.5],
            paddingHorizontal: theme.space[4],
            borderRadius: theme.radius.lg,
            borderBottomRightRadius: theme.radius.xs,
            backgroundColor: theme.colors.surfaceSunken,
          }}
        >
          <Text selectable style={[theme.text.body, { color: theme.colors.text }]}>
            {text}
          </Text>
        </View>
      </View>
    )
  }
  const note = message.origin ? originNote[message.origin] : undefined
  const streaming = message.status === 'streaming'
  return (
    <View style={{ gap: theme.space[2] }}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${agentName}${note ? `, ${note}` : ''}${
          streaming && turn === 'working'
            ? ', working'
            : streaming && turn === 'waiting'
              ? ', waiting for you'
              : moment
                ? `, ${moment}`
                : ''
        }`}
        style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.space[2] }}
      >
        <Txt variant="label" weight="semibold">
          {agentName}
        </Txt>
        {note ? (
          <Txt variant="label" tone="accent">
            {note}
          </Txt>
        ) : null}
        {streaming && turn === 'working' ? (
          <Working since={message.createdAt} />
        ) : streaming && turn === 'waiting' ? (
          <Txt variant="label" tone="tertiary">
            Waiting for you
          </Txt>
        ) : time ? (
          <Txt variant="label" tone="tertiary">
            {time}
          </Txt>
        ) : null}
      </View>
      <View style={{ gap: theme.space[2] }}>
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
              return <Reasoning key={index} text={part.text} />
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
              return <Notice key={index} level={part.level} text={part.text} />
          }
        })}
        {message.status === 'interrupted' ? (
          <Notice level="info" text="Stopped." />
        ) : null}
        {message.status === 'error' ? (
          <Notice level="error" text="This reply ended with an error." />
        ) : null}
      </View>
    </View>
  )
})

function Reasoning({ text }: { text: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={{ gap: theme.space[2] }}>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Reasoning"
        onPress={() => setOpen(!open)}
        style={{
          minHeight: theme.layout.touchTarget,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[1],
          alignSelf: 'flex-start',
        }}
      >
        <Chevron size={14} color={theme.colors.textTertiary} strokeWidth={1.75} />
        <Txt tone="tertiary">Reasoning</Txt>
      </Press>
      {open ? (
        <Text
          selectable
          style={[
            theme.text.ui,
            {
              color: theme.colors.textSecondary,
              paddingLeft: theme.space[3],
              borderLeftWidth: 2,
              borderLeftColor: theme.colors.border,
            },
          ]}
        >
          {text}
        </Text>
      ) : null}
    </View>
  )
}

export function Notice({
  level,
  text,
}: {
  level: 'info' | 'warning' | 'error'
  text: string
}) {
  const theme = useTheme()
  const { colors } = theme
  const palette =
    level === 'warning'
      ? { background: colors.warningSubtle, foreground: colors.warning }
      : level === 'error'
        ? { background: colors.dangerSubtle, foreground: colors.danger }
        : { background: colors.surfaceSunken, foreground: colors.textSecondary }
  return (
    <View
      style={{
        paddingVertical: theme.space[2],
        paddingHorizontal: theme.space[3],
        borderRadius: theme.radius.md,
        backgroundColor: palette.background,
      }}
    >
      <Text style={[theme.text.ui, { color: palette.foreground }]}>{text}</Text>
    </View>
  )
}
