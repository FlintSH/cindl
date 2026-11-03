import { useCan, useCindlApi, useLink } from '@cindl/client-react'
import { useState } from 'react'
import { TextInput, View, useWindowDimensions } from 'react-native'
import { newClientId } from '../platform/ids.ts'
import { useTheme } from '../theme/theme.tsx'
import { ArrowUp, Square } from '../ui/icons.ts'
import { Button, Txt } from '../ui/primitives.tsx'
import { describeFailure, NOT_APPLIED, SEND_UNCERTAIN } from './failures.ts'

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
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [unconfirmed, setUnconfirmed] = useState<string>()
  const [sending, setSending] = useState(false)
  const [focused, setFocused] = useState(false)
  const connected = link.phase === 'online'
  const ready = connected && canSend

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
      if (copy.certain) setText((current) => current || value)
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
        {canStop && canInterrupt ? (
          <Button
            label="Stop the current turn"
            icon={Square}
            iconOnly
            variant="quiet"
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
        ) : null}
        <Button
          label="Send"
          icon={ArrowUp}
          iconOnly
          variant="primary"
          disabled={!ready || !text.trim() || sending}
          busy={sending}
          onPress={() => void submit()}
        />
      </View>
      {hint ? (
        <Txt variant="label" tone="tertiary">
          {hint}
        </Txt>
      ) : null}
    </View>
  )
}
