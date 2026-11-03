import { entry } from '@cindl/client-core'
import {
  useCan,
  useCapability,
  useCindlApi,
  useCindlState,
  useLink,
} from '@cindl/client-react'
import {
  capabilityIds,
  type CapabilityState,
  type McpServerStatus,
} from '@cindl/contracts'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { agentSections, type AgentSection } from '../nav/navigation.ts'
import { useNav, useNavigate } from '../nav/NavProvider.tsx'
import { usePreference } from '../platform/PreferencesProvider.tsx'
import { linkCopy } from '../talk/presence.ts'
import type { ThemePreference } from '../theme/model.ts'
import { useTheme } from '../theme/theme.tsx'
import {
  Badge,
  Button,
  Dot,
  Empty,
  ErrorText,
  Facts,
  focusRing,
  Note,
  Row,
  Rows,
  Txt,
  type Tone,
} from '../ui/primitives.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { forgetDrafts } from '../views/drafts.ts'
import { Page, Section, Tabs } from '../views/Page.tsx'
import { RequireCapability } from '../views/RequireCapability.tsx'
import { useResource } from '../views/useResource.ts'

const sectionLabels: Record<AgentSection, string> = {
  identity: 'Identity',
  connections: 'Connections',
  runtime: 'Runtime',
  device: 'This device',
  appearance: 'Appearance',
}

const stateTone: Record<CapabilityState, Tone> = {
  available: 'success',
  limited: 'warning',
  unavailable: 'neutral',
  unsupported: 'neutral',
  unknown: 'neutral',
}
const stateLabel: Record<CapabilityState, string> = {
  available: 'Available',
  limited: 'Limited',
  unavailable: 'Unavailable',
  unsupported: 'Not supported',
  unknown: 'Not checked',
}

function Identity() {
  const api = useCindlApi()
  const canWrite = useCan('soul.write')
  const write = useCapability('soul.write')
  const soul = useResource(
    () => api.call('soul.read', {}),
    'soul',
    'SOUL.md could not be read.',
  )
  return (
    <Section title="SOUL.md">
      <Note>Who Hermes is for this profile: its truths, limits and voice.</Note>
      {soul.error ? <ErrorText>{soul.error}</ErrorText> : null}
      {!soul.data && !soul.error ? <Note>Loading SOUL.md…</Note> : null}
      {soul.data ? (
        <DocumentEditor
          document={soul.data}
          label="SOUL.md"
          canWrite={canWrite}
          writeNote={write?.reason}
          onReload={soul.reload}
          onSave={async (content, expectedVersion) => {
            const saved = await api.call('soul.write', {
              content,
              expectedVersion,
              confirm: true,
            })
            soul.replace(saved)
            return saved
          }}
        />
      ) : null}
    </Section>
  )
}

const mcpTone: Record<McpServerStatus['state'], Tone> = {
  connected: 'success',
  connecting: 'info',
  error: 'danger',
  disabled: 'neutral',
  unknown: 'neutral',
}

/** Mounted only inside the `connections.mcp` gate, so nothing is fetched before the check. */
function McpServers() {
  const api = useCindlApi()
  const mcp = useResource(
    () => api.call('connections.mcp', {}),
    'mcp',
    'MCP status could not be loaded.',
  )
  if (mcp.error) return <ErrorText>{mcp.error}</ErrorText>
  if (!mcp.data) return <Note>Loading MCP status…</Note>
  if (!mcp.data.length) return <Empty>No MCP servers are configured.</Empty>
  return (
    <Rows>
      {mcp.data.map((server) => (
        <Row
          key={server.name}
          title={server.name}
          leading={<Dot tone={mcpTone[server.state]} />}
          detail={
            server.error ??
            (server.toolCount !== undefined
              ? `${server.toolCount} tools`
              : 'No tool count reported')
          }
          aside={<Badge tone={mcpTone[server.state]}>{server.state}</Badge>}
        />
      ))}
    </Rows>
  )
}

function Connections() {
  return (
    <>
      <Section title="MCP servers">
        <Note>
          Cached health reported by Hermes. Opening this page does not probe or reconnect
          anything.
        </Note>
        <RequireCapability id="connections.mcp" label="MCP status">
          <McpServers />
        </RequireCapability>
      </Section>
      <Section title="Accounts">
        <Note>
          Cindl keeps these separate: a stored credential, a signed-in browser session and
          an API-verified login are different evidence, and MFA-required or expired logins
          are shown as such.
        </Note>
        <RequireCapability id="connections.accounts" label="Account coverage">
          <Note>Account coverage is available.</Note>
        </RequireCapability>
      </Section>
    </>
  )
}

function Runtime() {
  const theme = useTheme()
  const link = useLink()
  const capabilities = useCindlState((state) => state.capabilities)
  const copy = linkCopy(link.phase, link.demo)
  return (
    <>
      <Section title="Connection">
        <Facts
          items={[
            {
              label: 'Status',
              value: (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.space[2],
                  }}
                >
                  <Dot tone={copy.tone} />
                  <Txt>{copy.label}</Txt>
                </View>
              ),
            },
            { label: 'Hermes origin', value: link.server?.origin ?? 'Not configured' },
            {
              label: 'Hermes version',
              value: `${link.server?.hermesVersion ?? 'Unknown'}${
                link.server?.untestedVersion
                  ? ' (outside the verified baseline v0.22.5)'
                  : ''
              }`,
            },
            {
              label: 'Protocol',
              value:
                link.server?.authority === 'canonical'
                  ? 'Canonical session authority'
                  : link.server?.authority === 'legacy-sidecar-v8'
                    ? 'Desktop backend contract 8 (sidecar)'
                    : 'Not negotiated',
            },
            {
              label: 'Shared live session',
              value: link.server?.sessionAuthority
                ? 'Proven by the handshake'
                : 'Not proven: other Hermes surfaces may run separate live sessions',
            },
            {
              label: 'Sign-in',
              value:
                link.auth === 'native-pkce'
                  ? 'Native sign-in (PKCE)'
                  : link.auth === 'same-origin-cookie'
                    ? 'Same-origin Hermes session'
                    : link.auth === 'demo-fixture'
                      ? 'None (synthetic demo)'
                      : 'Not signed in',
            },
          ]}
        />
      </Section>
      <Section title="Capabilities">
        <Rows>
          {capabilityIds.map((id) => {
            const capability = entry(capabilities, id)
            const state = capability?.state ?? 'unknown'
            const why =
              capability?.reason ??
              (capability ? (capability.source.endpoint ?? '') : 'Not checked yet.')
            return (
              <View
                key={id}
                accessible
                accessibilityLabel={`${id}: ${stateLabel[state]}${why ? `. ${why}` : ''}`}
                style={{
                  gap: theme.space[1],
                  paddingVertical: theme.space[3],
                  paddingHorizontal: theme.space[4],
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: theme.space[2],
                  }}
                >
                  <Text style={[theme.text.code, { color: theme.colors.text }]}>
                    {id}
                  </Text>
                  <Badge tone={stateTone[state]}>{stateLabel[state]}</Badge>
                </View>
                {why ? (
                  <Txt variant="label" tone="secondary">
                    {why}
                  </Txt>
                ) : null}
              </View>
            )
          })}
        </Rows>
      </Section>
    </>
  )
}

function Device() {
  const api = useCindlApi()
  const link = useLink()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <>
      <Section title="This device">
        <Txt>
          Signing out forgets this device's Hermes tokens. Hermes v0.22.5 cannot revoke
          tokens it already issued, so this is a local sign-out: it does not end sessions
          on other devices.
        </Txt>
        <Button
          label="Sign out on this device"
          style={{ alignSelf: 'flex-start' }}
          disabled={link.phase === 'signed-out'}
          onPress={() => {
            setError(undefined)
            api.call('auth.signOut', {}).then(
              () => {
                forgetDrafts()
                setDone(true)
              },
              () =>
                setError(
                  'Signing out did not complete. Try again; until it does, this device may still be signed in.',
                ),
            )
          }}
        />
        {done ? (
          <Txt variant="label" tone="tertiary" accessibilityLiveRegion="polite">
            Signed out on this device.
          </Txt>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
      </Section>
      <Section title="On this device">
        <Facts
          items={[
            {
              label: 'Hermes tokens',
              value:
                "Encrypted with a key in Android's Keystore; never in app storage or logs.",
            },
            {
              label: 'Sign-in',
              value:
                "Your Hermes server's own login page, in the system browser. Cindl never asks for your password.",
            },
            {
              label: 'Preferences',
              value: 'App storage on this device, excluded from backups.',
            },
          ]}
        />
      </Section>
    </>
  )
}

function Appearance() {
  const theme = useTheme()
  const [preference, setPreference] = usePreference('theme')
  const options: Array<{ id: ThemePreference; label: string }> = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ]
  return (
    <Section title="Theme">
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Theme"
        style={{
          flexDirection: 'row',
          alignSelf: 'flex-start',
          padding: theme.space[0.5],
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceSunken,
        }}
      >
        {options.map((option) => (
          <Segment
            key={option.id}
            label={option.label}
            checked={preference === option.id}
            onPress={() => setPreference(option.id)}
          />
        ))}
      </View>
      <Note>Motion follows your system's reduced-motion setting.</Note>
      <Note>Text follows your system font size.</Note>
    </Section>
  )
}

function Segment({
  label,
  checked,
  onPress,
}: {
  label: string
  checked: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        {
          minHeight: theme.layout.touchTarget,
          justifyContent: 'center',
          paddingHorizontal: theme.space[4],
          borderRadius: theme.radius.sm,
          backgroundColor: checked ? theme.colors.surfaceRaised : 'transparent',
          boxShadow: checked ? theme.shadow.raised : undefined,
        },
        focused ? focusRing(theme) : null,
      ]}
    >
      <Text
        style={[
          theme.text.ui,
          {
            fontFamily: theme.fonts.medium,
            color: checked ? theme.colors.text : theme.colors.textSecondary,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

export function AgentView() {
  const nav = useNav()
  const navigate = useNavigate()
  const section = nav.agentSection
  return (
    <Page
      title="Agent"
      lead="Who Hermes is, what it is connected to, and how this device reaches it."
      tabs={
        <Tabs
          label="Agent sections"
          items={agentSections.map((id) => ({ id, label: sectionLabels[id] }))}
          current={section}
          onSelect={(id) => navigate({ type: 'agent-section', section: id })}
        />
      }
    >
      {section === 'identity' ? (
        <RequireCapability id="soul.read" label="Identity">
          <Identity />
        </RequireCapability>
      ) : null}
      {section === 'connections' ? <Connections /> : null}
      {section === 'runtime' ? <Runtime /> : null}
      {section === 'device' ? <Device /> : null}
      {section === 'appearance' ? <Appearance /> : null}
    </Page>
  )
}
