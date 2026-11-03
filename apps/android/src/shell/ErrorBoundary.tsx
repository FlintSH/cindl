import { redactText } from '@cindl/hermes-adapter'
import * as SplashScreen from 'expo-splash-screen'
import { Component, type ReactNode } from 'react'
import { ScrollView, Text } from 'react-native'
import { buildTheme } from '../theme/model.ts'

/**
 * Last-resort screen if rendering throws. It shows a redacted message and
 * nothing else; it does not log, retry or fall back to other data.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | undefined }
> {
  override state: { error: string | undefined } = { error: undefined }

  static getDerivedStateFromError(error: unknown) {
    return { error: redactText(error instanceof Error ? error.message : 'Unknown error') }
  }

  override componentDidCatch() {
    // The splash would otherwise cover this screen if the first render failed.
    void SplashScreen.hideAsync().catch(() => undefined)
  }

  override render() {
    if (this.state.error === undefined) return this.props.children
    const theme = buildTheme('light')
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.canvas }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: theme.space[6],
          gap: theme.space[3],
        }}
      >
        <Text
          accessibilityRole="header"
          style={[theme.text.heading, { color: theme.colors.text }]}
        >
          Cindl stopped working
        </Text>
        <Text style={[theme.text.ui, { color: theme.colors.textSecondary }]}>
          Close and reopen the app. If this keeps happening, report it with the message
          below (it contains no tokens).
        </Text>
        <Text selectable style={[theme.text.code, { color: theme.colors.danger }]}>
          {this.state.error}
        </Text>
      </ScrollView>
    )
  }
}
