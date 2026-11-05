import { useCan, useCindlApi, useLink } from '@cindl/client-react'
import { useState } from 'react'
import { TextInput, View, useWindowDimensions } from 'react-native'
import { newClientId } from '../platform/ids.ts'
import { useTheme } from '../theme/theme.tsx'
import { ArrowUp, Square } from '../ui/icons.ts'
import { Button, Txt } from '../ui/primitives.tsx'
import { describeFailure, NOT_APPLIED, SEND_UNCERTAIN } from './failures.ts'
import { keepPlace, placeOf } from './places.ts'

/**
 * Non-blocking: the owner can send while Hermes works or waits (Hermes
 * queues, steers or redirects). Sending needs `chat.stream`, stopping
 * `chat.interrupt`. When the outcome of a send is unknown the text is not put
 * back by itself (that would invite a duplicate); the owner can restore it.
 * On Android the Enter key adds a line; the Send button sends.
 */
export function Composer({
  conversationId,
  canStop,
  hint,
  agentName,
}: {
  conversationId: string
  canStop: boolean
  hint: string | undefined
  agentName: string
}) {
  const api = useCindlApi()
  const theme = useTheme()
  const link = useLink()
  const canSend = useCan('chat.stream')
  const canInterrupt = useCan('chat.interrupt')
  const { height } = useWindowDimensions()
  // The unsent message belongs to its conversation (TalkView keys the composer
  // by conversation) and waits there while the owner is elsewhere, so it never
  // follows them into another conversation (web parity, places.ts).
  const [text, setTextNow] = useState(() => placeOf(conversationId).draft)
  const setText = (value: string) => {
    setTextNow(value)
    keepPlace(conversationId, { draft: value })
  }
  // So does a send's outcome: one that fails after the owner left is said
  // when they come back (review 4bdfe6c1, S-5).
  const [error, setErrorNow] = useState(() => placeOf(conversationId).failure)
  const setError = (message: string | undefined) => {
    setErrorNow(message)
    keepPlace(conversationId, { failure: message })
  }
  const [unconfirmed, setUnconfirmedNow] = useState(
    () => placeOf(conversationId).unconfirmed,
  )
  const setUnconfirmed = (value: string | undefined) => {
    setUnconfirmedNow(value)
    keepPlace(conversationId, { unconfirmed: value })
  }
  const [sending, setSending] = useState(false)
  const [focused, setFocused] = useState(false)
  const connected = link.phase === 'online'
  const ready = connected && canSend
  const sendable = ready && !sending && text.trim().length > 0
  const stopping = canStop && canInterrupt && !text.trim()

  const submit = async () => {
    const value = text.trim()
    if (!value || !ready || sending) return
    setError(undefined)
    setUnconfirmed(undefined)
    setText('')
    setSending(true)
    try {
      await api.call('prompt.submit', {
        conversationId,
        clientId: newClientId(),
        text: value,
      })
    } catch (failure) {
      const copy = describeFailure(failure, SEND_UNCERTAIN, NOT_APPLIED)
      // Back into this conversation's draft, even if the owner left it meanwhile.
      if (copy.certain) setText(placeOf(conversationId).draft || value)
      else setUnconfirmed(value)
      setError(copy.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={{ gap: theme.space[2] }}>
      {error ? (
        <View style={{ gap: theme.space[1] }}>
          <Txt
            variant="label"
            tone="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            {error}
          </Txt>
          {unconfirmed !== undefined ? (
            <Button
              label="Put the text back"
              variant="quiet"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => {
                setText(unconfirmed)
                setUnconfirmed(undefined)
                setError(undefined)
              }}
            />
          ) : null}
        </View>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: theme.space[2],
          paddingVertical: theme.space[1],
          paddingLeft: theme.space[4],
          paddingRight: theme.space[1],
          borderWidth: focused ? 2 : 1,
          borderColor: focused ? theme.colors.focus : theme.colors.borderStrong,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surfaceRaised,
          boxShadow: theme.shadow.raised,
        }}
      >
        <TextInput
          accessibilityLabel={`Message ${agentName}`}
          {...(hint ? { accessibilityHint: hint } : {})}
          placeholder={
            ready
              ? `Message ${agentName}`
              : connected
                ? 'Sending is not available on this connection.'
                : 'Not connected. Messages cannot be sent.'
          }
          placeholderTextColor={theme.colors.textTertiary}
          value={text}
          onChangeText={setText}
          editable={ready}
          multiline
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[
            theme.text.body,
            {
              flex: 1,
              minHeight: theme.layout.touchTarget,
              maxHeight: Math.max(120, height * 0.3),
              paddingVertical: theme.space[2],
              color: theme.colors.text,
              textAlignVertical: 'center',
            },
          ]}
        />
        {/* One primary slot (web parity, after T3 Code): Stop while Hermes works
            and the box is empty, Send as soon as there is text. */}
        {stopping ? (
          // A bordered control with a solid square, so it never reads as a checkbox.
          <Button
            label="Stop the current turn"
            icon={Square}
            filledIcon
            iconOnly
            style={{ borderColor: theme.colors.borderStrong }}
            onPress={() =>
              void api.call('conversation.interrupt', { conversationId }).then(
                () => setError(undefined),
                (failure: unknown) =>
                  setError(
                    describeFailure(
                      failure,
                      'Hermes did not confirm the stop. The turn may still be running.',
                    ).message,
                  ),
              )
            }
          />
        ) : (
          <Button
            label="Send"
            icon={ArrowUp}
            iconOnly
            variant={sendable ? 'primary' : 'quiet'}
            disabled={!sendable}
            busy={sending}
            style={
              sendable
                ? undefined
                : { backgroundColor: theme.colors.surfaceSunken, opacity: 1 }
            }
            onPress={() => void submit()}
          />
        )}
      </View>
      {hint ? (
        <Txt variant="label" tone="tertiary">
          {hint}
        </Txt>
      ) : null}
    </View>
  )
}
