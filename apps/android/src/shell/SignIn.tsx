import { useCindlApi, useLink } from '@cindl/client-react'
import { useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { isCindlError } from '@cindl/contracts'
import { normalizeOrigin } from '../platform/origin.ts'
import { useTheme } from '../theme/theme.tsx'
import { Mark } from '../ui/Mark.tsx'
import { Button, ErrorText, Note, Txt } from '../ui/primitives.tsx'

/**
 * Sign-in for a signed-out or unconfigured link. Only the server address is
 * entered here; the password (and any second factor) goes to Hermes's own
 * login page in the system browser.
 */
export function SignIn() {
  const api = useCindlApi()
  const theme = useTheme()
  const link = useLink()
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const submit = () => {
    const check = normalizeOrigin(address)
    if (!check.ok) {
      setError(check.reason)
      return
    }
    setError(undefined)
    setPending(true)
    api.call('auth.signIn', { origin: check.origin }).then(
      () => setPending(false),
      (failure: unknown) => {
        setPending(false)
        setError(
          isCindlError(failure) ? failure.message : 'Sign-in did not finish. Try again.',
        )
      },
    )
  }
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        gap: theme.space[4],
        padding: theme.space[6],
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Mark size={28} />
      <Text
        accessibilityRole="header"
        style={[theme.text.heading, { color: theme.colors.text }]}
      >
        {link.phase === 'signed-out' ? 'Signed out' : 'Sign in to Hermes'}
      </Text>
      <Txt variant="body" tone="secondary">
        Cindl signs in through your Hermes server's own login page in your browser. Your
        password stays there; Cindl keeps only the resulting tokens, encrypted on this
        device.
      </Txt>
      <View style={{ gap: theme.space[2] }}>
        <Txt variant="label" tone="secondary" weight="medium">
          Hermes address
        </Txt>
        <TextInput
          accessibilityLabel="Hermes address"
          placeholder="https://hermes.example.test"
          placeholderTextColor={theme.colors.textTertiary}
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
          returnKeyType="go"
          editable={!pending}
          onSubmitEditing={submit}
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
        <Note>
          Use https://. Plain http works only for this device itself (127.0.0.1).
        </Note>
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {pending ? (
        <Txt tone="tertiary" accessibilityLiveRegion="polite">
          Finish signing in in your browser, then close the tab to return here.
        </Txt>
      ) : null}
      <Button
        label="Sign in"
        variant="primary"
        disabled={pending || !address.trim()}
        busy={pending}
        style={{ alignSelf: 'flex-start' }}
        onPress={submit}
      />
    </ScrollView>
  )
}
