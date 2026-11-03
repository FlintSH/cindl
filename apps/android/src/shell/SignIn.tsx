import { useCindlApi, useLink } from '@cindl/client-react'
import { isCindlError } from '@cindl/contracts'
import { useRef, useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { normalizeOrigin } from '../platform/origin.ts'
import { useTheme } from '../theme/theme.tsx'
import { Mark } from '../ui/Mark.tsx'
import { Button, ErrorText, Note, Txt } from '../ui/primitives.tsx'
import { useSignInControls } from './signInControls.ts'

export const SIGN_IN_FAILED = 'Sign-in did not finish. Nothing was saved. Try again.'

/**
 * Sign-in for a real build with no Hermes session (web parity:
 * apps/web/src/shell/SignIn.tsx). Only the server address is entered here;
 * the password and any second factor go to Hermes's own page in the browser,
 * and the adapter's NativeAuth (run by the direct client) exchanges the code.
 */
export function SignIn({ onAttempt }: { onAttempt: () => void }) {
  const api = useCindlApi()
  const theme = useTheme()
  const link = useLink()
  const controls = useSignInControls()
  const [address, setAddress] = useState(link.server?.origin ?? '')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  // Only the latest attempt may change this screen.
  const attempt = useRef(0)
  const submit = () => {
    if (pending) return
    const check = normalizeOrigin(address)
    if (!check.ok) {
      setError(check.reason)
      return
    }
    const mine = ++attempt.current
    setError(undefined)
    setPending(true)
    onAttempt()
    api.call('auth.signIn', { origin: check.origin }).then(
      () => {
        if (mine === attempt.current) setPending(false)
      },
      (failure: unknown) => {
        if (mine !== attempt.current) return
        setPending(false)
        setError(isCindlError(failure) ? failure.message : SIGN_IN_FAILED)
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
          Use https://. Plain http works only for this device itself (127.0.0.1 or [::1]).
        </Note>
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {pending ? (
        <Txt tone="tertiary" accessibilityLiveRegion="polite">
          Finish signing in in your browser, then close the tab to return here.
        </Txt>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button
          label="Sign in"
          variant="primary"
          disabled={pending || !address.trim()}
          busy={pending}
          onPress={submit}
        />
        {pending && controls ? (
          <Button label="Cancel sign-in" variant="quiet" onPress={controls.cancel} />
        ) : null}
      </View>
      <Note>
        Signing out later is local to this device: Hermes v0.22.5 cannot revoke tokens it
        already issued.
      </Note>
    </ScrollView>
  )
}
