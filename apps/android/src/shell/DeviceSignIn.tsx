import type { NativeTokenSet } from '@cindl/hermes-adapter'
import { useEffect, useState } from 'react'
import { TextInput, View } from 'react-native'
import {
  keepSignIn,
  signInFailure,
  signOutDevice,
  startDeviceSession,
} from '../auth/deviceSession.ts'
import { createAndroidPlatform, type AndroidPlatform } from '../platform/android.ts'
import { normalizeOrigin } from '../platform/origin.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, ErrorText, Note, Txt } from '../ui/primitives.tsx'

type Phase =
  | { phase: 'checking' }
  | { phase: 'signed-out' }
  | { phase: 'signing-in'; origin: string }
  | { phase: 'signed-in'; origin: string }

/**
 * Native sign-in for a real build that cannot open the Hermes connection yet
 * (NotConnected). The owner signs in on Hermes's own page in the browser;
 * Cindl keeps the tokens encrypted on this device for when the connection is
 * part of the app. Nothing here pretends to be connected.
 */
export function DeviceSignIn() {
  const theme = useTheme()
  const [platform, setPlatform] = useState<AndroidPlatform>()
  const [state, setState] = useState<Phase>({ phase: 'checking' })
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string>()

  const finish = (
    from: AndroidPlatform,
    origin: string,
    tokens: Promise<NativeTokenSet>,
  ) => {
    setState({ phase: 'signing-in', origin })
    tokens
      .then(async (issued) => {
        await keepSignIn(from, origin, issued)
        setError(undefined)
        setState({ phase: 'signed-in', origin })
      })
      .catch((failure: unknown) => {
        setError(signInFailure(failure))
        setState({ phase: 'signed-out' })
      })
  }

  useEffect(() => {
    let current = true
    createAndroidPlatform()
      .then(async (created) => {
        const startup = await startDeviceSession(created)
        if (!current) return
        setPlatform(created)
        if (startup.kind === 'resume') {
          finish(created, startup.attempt.origin, created.resumeSignIn(startup.attempt))
          return
        }
        setError(startup.notice)
        setState(
          startup.kind === 'signed-in'
            ? { phase: 'signed-in', origin: startup.origin }
            : { phase: 'signed-out' },
        )
      })
      .catch((failure: unknown) => {
        if (!current) return
        setError(signInFailure(failure))
        setState({ phase: 'signed-out' })
      })
    return () => {
      current = false
    }
  }, [])

  const submit = () => {
    if (!platform) return
    const check = normalizeOrigin(address)
    if (!check.ok) {
      setError(check.reason)
      return
    }
    setError(undefined)
    finish(
      platform,
      check.origin,
      platform.signIn(check.origin).then((result) => result.tokens),
    )
  }

  const signOut = (origin: string) => {
    if (!platform) return
    signOutDevice(platform, origin).then(
      () => setState({ phase: 'signed-out' }),
      () => setError('Cindl could not delete the tokens on this device. Try again.'),
    )
  }

  return (
    <View style={{ gap: theme.space[3] }}>
      <Txt variant="title" accessibilityRole="header">
        Sign in on this device
      </Txt>
      {state.phase === 'signed-in' ? (
        <>
          <Txt variant="body" accessibilityLiveRegion="polite">
            {`Signed in to ${state.origin} on this device.`}
          </Txt>
          <Txt tone="secondary">
            Cindl keeps the tokens encrypted on this device and uses them once the
            connection is part of the app. Signing out deletes them from this device only:
            Hermes v0.22.5 cannot revoke tokens it already issued.
          </Txt>
          <Button
            label="Sign out on this device"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => signOut(state.origin)}
          />
        </>
      ) : (
        <>
          <Txt tone="secondary">
            You can sign in already, on your Hermes server&apos;s own login page in your
            browser. Your password stays there; Cindl keeps only the resulting tokens,
            encrypted on this device.
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
              editable={state.phase === 'signed-out'}
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
          {state.phase === 'signing-in' ? (
            <Txt tone="tertiary" accessibilityLiveRegion="polite">
              Finish signing in in your browser, then close the tab to return here.
            </Txt>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
            <Button
              label="Sign in"
              variant="primary"
              disabled={state.phase !== 'signed-out' || !address.trim()}
              busy={state.phase === 'signing-in'}
              onPress={submit}
            />
            {state.phase === 'signing-in' ? (
              <Button
                label="Cancel sign-in"
                onPress={() => void platform?.cancelSignIn().catch(() => undefined)}
              />
            ) : null}
          </View>
        </>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  )
}
