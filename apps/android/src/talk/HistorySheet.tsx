import { useCan, useCapability, useCindlApi, useConversations } from '@cindl/client-react'
import { isCindlError, type Conversation } from '@cindl/contracts'
import { useMemo, useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { Sheet } from '../overlay/Sheet.tsx'
import { useTheme } from '../theme/theme.tsx'
import { Pin, Plus } from '../ui/icons.ts'
import { Badge, Note, Press, Txt } from '../ui/primitives.tsx'
import { fuzzyScore, listTime } from './format.ts'

/** Searchable conversation switcher (the web history popover, as a sheet). */
export function HistorySheet({
  open,
  onClose,
  currentId,
  onOpenConversation,
}: {
  open: boolean
  onClose: () => void
  currentId: string | undefined
  onOpenConversation: (id: string) => void
}) {
  const api = useCindlApi()
  const theme = useTheme()
  const conversations = useConversations()
  const canCreate = useCan('sessions.create')
  const createCapability = useCapability('sessions.create')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  const filtered = useMemo(
    () =>
      conversations.filter(
        (c) => fuzzyScore(query, `${c.title} ${c.preview ?? ''}`) !== undefined,
      ),
    [conversations, query],
  )
  const close = () => {
    setQuery('')
    setError(undefined)
    onClose()
  }
  const openConversation = (id: string) => {
    close()
    onOpenConversation(id)
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Conversations"
      closeLabel="Close conversations"
    >
      <View style={{ padding: theme.space[3], paddingBottom: theme.space[2] }}>
        <TextInput
          accessibilityLabel="Search conversations"
          placeholder="Search conversations"
          placeholderTextColor={theme.colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          style={[
            theme.text.body,
            {
              minHeight: theme.layout.touchTarget,
              paddingHorizontal: theme.space[3],
              borderWidth: 1,
              borderColor: theme.colors.borderStrong,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceRaised,
              color: theme.colors.text,
            },
          ]}
        />
      </View>
      <ScrollView
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ padding: theme.space[1], paddingTop: 0 }}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.map((conversation) => (
          <ConversationItem
            key={conversation.id}
            conversation={conversation}
            current={conversation.id === currentId}
            onPress={() => openConversation(conversation.id)}
          />
        ))}
        {filtered.length === 0 ? (
          <View style={{ padding: theme.space[4] }}>
            <Txt tone="tertiary">No conversations match.</Txt>
          </View>
        ) : null}
      </ScrollView>
      <View
        style={{
          borderTopWidth: 1,
          borderColor: theme.colors.border,
          padding: theme.space[1],
          gap: theme.space[1],
        }}
      >
        {canCreate ? (
          <Press
            accessibilityRole="button"
            accessibilityLabel="New side conversation"
            android_ripple={{ color: theme.colors.selection }}
            onPress={() =>
              void api.call('conversations.create', {}).then(
                (created) => openConversation(created.id),
                (failure: unknown) =>
                  setError(
                    isCindlError(failure)
                      ? failure.message
                      : 'The side conversation could not be started.',
                  ),
              )
            }
            style={{
              minHeight: theme.layout.touchTarget,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space[2],
              paddingHorizontal: theme.space[3],
              borderRadius: theme.radius.md,
            }}
          >
            <Plus size={15} color={theme.colors.accentText} strokeWidth={2} />
            <Txt tone="accent" weight="medium">
              New side conversation
            </Txt>
          </Press>
        ) : (
          <View style={{ padding: theme.space[3] }}>
            <Note>
              {`Starting side conversations is not available: ${
                createCapability?.reason ?? 'not checked on this connection yet.'
              }`}
            </Note>
          </View>
        )}
        {error ? (
          <View
            style={{ paddingHorizontal: theme.space[3], paddingBottom: theme.space[2] }}
          >
            <Txt variant="label" tone="danger" accessibilityRole="alert">
              {error}
            </Txt>
          </View>
        ) : null}
      </View>
    </Sheet>
  )
}

function ConversationItem({
  conversation,
  current,
  onPress,
}: {
  conversation: Conversation
  current: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const day = listTime(conversation.updatedAt)
  const status =
    conversation.status === 'waiting-on-you'
      ? 'Needs you'
      : conversation.status === 'working'
        ? 'Working'
        : undefined
  const label = [
    conversation.title,
    conversation.kind === 'main' ? 'Main' : undefined,
    status,
    day,
    conversation.preview,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: current }}
      android_ripple={{ color: theme.colors.selection }}
      onPress={onPress}
      style={{
        minHeight: theme.layout.touchTarget,
        gap: theme.space[0.5],
        paddingVertical: theme.space[2],
        paddingHorizontal: theme.space[3],
        borderRadius: theme.radius.md,
        backgroundColor: current ? theme.colors.surfaceSunken : 'transparent',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        {conversation.kind === 'main' ? (
          <Pin size={13} color={theme.colors.textSecondary} strokeWidth={1.75} />
        ) : null}
        <Text
          numberOfLines={1}
          style={[
            theme.text.ui,
            { flex: 1, fontFamily: theme.fonts.medium, color: theme.colors.text },
          ]}
        >
          {conversation.title}
        </Text>
        {status ? (
          <Badge tone={status === 'Needs you' ? 'accent' : 'info'}>{status}</Badge>
        ) : null}
        {day ? (
          <Txt variant="label" tone="tertiary">
            {day}
          </Txt>
        ) : null}
      </View>
      {conversation.preview ? (
        <Text
          numberOfLines={1}
          style={[theme.text.label, { color: theme.colors.textSecondary }]}
        >
          {conversation.preview}
        </Text>
      ) : null}
    </Press>
  )
}
