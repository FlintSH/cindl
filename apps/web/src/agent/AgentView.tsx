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
import { usePreference, type ThemePreference } from '../platform/preferences.ts'
import { formatRoute, type AgentSection } from '../router.ts'
import { linkCopy } from '../shell/LinkStatus.tsx'
import { Badge, Button, Dot, SectionTitle, type Tone } from '../ui/primitives.tsx'
import { RequireCapability } from '../views/Capability.tsx'
import { useClientKind } from '../platform/clientKind.ts'
import { signOutHere } from '../shell/signOut.ts'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { useResource } from '../views/useResource.ts'
import styles from '../views/views.module.css'

const sections: Array<{ id: AgentSection; label: string }> = [
  { id: 'identity', label: 'Identity' },
  { id: 'connections', label: 'Connections' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'device', label: 'This device' },
  { id: 'appearance', label: 'Appearance' },
]

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
    <section className={styles.section} aria-labelledby="soul-title">
      <SectionTitle id="soul-title">SOUL.md</SectionTitle>
      <p className={styles.note}>
        Who Hermes is for this profile: its truths, limits and voice.
      </p>
      {soul.error ? <p className={styles.error}>{soul.error}</p> : null}
      {soul.data ? (
        <DocumentEditor
          document={soul.data}
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
    </section>
  )
}

const mcpTone: Record<McpServerStatus['state'], Tone> = {
  connected: 'success',
  connecting: 'info',
  error: 'danger',
  disabled: 'neutral',
  unknown: 'neutral',
}

/** Fetched only after the connections.mcp capability check passes. */
function McpServers() {
  const api = useCindlApi()
  const mcp = useResource(
    () => api.call('connections.mcp', {}),
    'mcp',
    'MCP status could not be loaded.',
  )
  const servers = mcp.data
  const error = mcp.error
  return (
    <>
      {error ? <p className={styles.error}>{error}</p> : null}
      {servers?.length === 0 ? (
        <p className={styles.empty}>No MCP servers are configured.</p>
      ) : null}
      {servers?.length ? (
        <ul className={styles.rows}>
          {servers.map((server) => (
            <li key={server.name} className={styles.row}>
              <span className={styles.rowTitle}>
                <Dot tone={mcpTone[server.state]} /> {server.name}
              </span>
              <span className={styles.rowDetail}>
                {server.error ??
                  (server.toolCount !== undefined
                    ? `${server.toolCount} tools`
                    : 'No tool count reported')}
              </span>
              <span className={styles.rowAside}>
                <Badge tone={mcpTone[server.state]}>{server.state}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

function Connections() {
  return (
    <>
      <section className={styles.section} aria-labelledby="mcp-title">
        <SectionTitle id="mcp-title">MCP servers</SectionTitle>
        <p className={styles.note}>
          Cached health reported by Hermes. Opening this page does not probe or reconnect
          anything.
        </p>
        <RequireCapability id="connections.mcp" label="MCP status">
          <McpServers />
        </RequireCapability>
      </section>
      <section className={styles.section} aria-labelledby="accounts-title">
        <SectionTitle id="accounts-title">Accounts</SectionTitle>
        <p className={styles.note}>
          Cindl keeps these separate: a stored credential, a signed-in browser session and
          an API-verified login are different evidence, and MFA-required or expired logins
          are shown as such.
        </p>
        <RequireCapability id="connections.accounts" label="Account coverage">
          <p className={styles.note}>Account coverage is available.</p>
        </RequireCapability>
      </section>
    </>
  )
}

function Runtime() {
  const link = useLink()
  const capabilities = useCindlState((state) => state.capabilities)
  const copy = linkCopy(link.phase, link.demo)
  return (
    <>
      <section className={styles.section} aria-labelledby="link-title">
        <SectionTitle id="link-title">Connection</SectionTitle>
        <dl className={styles.facts}>
          <dt>Status</dt>
          <dd>
            <Dot tone={copy.tone} /> {copy.label}
          </dd>
          <dt>Hermes origin</dt>
          <dd>{link.server?.origin ?? 'Not configured'}</dd>
          <dt>Hermes version</dt>
          <dd>
            {link.server?.hermesVersion ?? 'Unknown'}
            {link.server?.untestedVersion
              ? ' (outside the verified baseline v0.22.5)'
              : ''}
          </dd>
          <dt>Protocol</dt>
          <dd>
            {link.server?.authority === 'canonical'
              ? 'Canonical session authority'
              : link.server?.authority === 'legacy-sidecar-v8'
                ? 'Desktop backend contract 8 (sidecar)'
                : 'Not negotiated'}
          </dd>
          <dt>Shared live session</dt>
          <dd>
            {link.server?.sessionAuthority
              ? 'Proven by the handshake'
              : 'Not proven: other Hermes surfaces may run separate live sessions'}
          </dd>
          <dt>Sign-in</dt>
          <dd>
            {link.auth === 'native-pkce'
              ? 'Native sign-in (PKCE)'
              : link.auth === 'same-origin-cookie'
                ? 'Same-origin Hermes session'
                : link.auth === 'demo-fixture'
                  ? 'None (synthetic demo)'
                  : 'Not signed in'}
          </dd>
        </dl>
      </section>
      <section className={styles.section} aria-labelledby="caps-title">
        <SectionTitle id="caps-title">Capabilities</SectionTitle>
        <div className={styles.tableScroll}>
          <table className={styles.capTable}>
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">State</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {capabilityIds.map((id) => {
                const capability = capabilities[id]
                const state = capability?.state ?? 'unknown'
                return (
                  <tr key={id}>
                    <td>
                      <code>{id}</code>
                    </td>
                    <td>
                      <Badge tone={stateTone[state]}>{stateLabel[state]}</Badge>
                    </td>
                    <td>
                      {capability?.reason ??
                        (capability
                          ? (capability.source.endpoint ?? '')
                          : 'Not checked yet.')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function Device() {
  const api = useCindlApi()
  const link = useLink()
  // Served by Hermes: the session is Hermes's cookie in this browser.
  const served = useClientKind() === 'hermes'
  const [outcome, setOutcome] = useState<'done' | 'failed'>()
  return (
    <section className={styles.section} aria-labelledby="device-title">
      <SectionTitle id="device-title">This device</SectionTitle>
      {served ? (
        <p>
          Signing out asks Hermes to clear its session cookie in this browser. Hermes may
          not end the session on its side (its basic sign-in revokes nothing), so a copy
          of that cookie can keep working until it expires, and other devices stay signed
          in.
        </p>
      ) : (
        <p>
          Signing out forgets this device's Hermes tokens. Hermes v0.22.5 cannot revoke
          tokens it already issued, so this is a local sign-out: it does not end sessions
          on other devices.
        </p>
      )}
      <div className={styles.actions}>
        <Button
          disabled={link.phase === 'signed-out'}
          onClick={() => {
            setOutcome(undefined)
            void signOutHere(api).then(
              () => setOutcome('done'),
              () => setOutcome('failed'),
            )
          }}
        >
          Sign out on this device
        </Button>
      </div>
      {outcome === 'failed' ? (
        <p className={styles.error} role="alert">
          Signing out did not complete. Try again; until it does, this device may still be
          signed in.
        </p>
      ) : null}
      {outcome === 'done' ? (
        <p className={styles.note} role="status">
          Signed out on this device.
        </p>
      ) : null}
    </section>
  )
}

function Appearance() {
  const [theme, setTheme] = usePreference('theme')
  const options: Array<{ id: ThemePreference; label: string }> = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ]
  return (
    <section className={styles.section} aria-labelledby="appearance-title">
      <SectionTitle id="appearance-title">Theme</SectionTitle>
      <div
        className={styles.segmented}
        role="radiogroup"
        aria-labelledby="appearance-title"
      >
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={theme === option.id}
            className={styles.segment}
            onClick={() => setTheme(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className={styles.note}>Motion follows your system's reduced-motion setting.</p>
    </section>
  )
}

export function AgentView({ section }: { section: AgentSection }) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Agent</h1>
          <p className={styles.pageLead}>
            Who Hermes is, what it is connected to, and how this device reaches it.
          </p>
        </header>
        <nav className={styles.tabs} aria-label="Agent sections">
          {sections.map((s) => (
            <a
              key={s.id}
              className={styles.tab}
              href={formatRoute({ view: 'agent', section: s.id })}
              aria-current={section === s.id ? 'page' : undefined}
            >
              {s.label}
            </a>
          ))}
        </nav>
        {section === 'identity' ? (
          <RequireCapability id="soul.read" label="Identity">
            <Identity />
          </RequireCapability>
        ) : null}
        {section === 'connections' ? <Connections /> : null}
        {section === 'runtime' ? <Runtime /> : null}
        {section === 'device' ? <Device /> : null}
        {section === 'appearance' ? <Appearance /> : null}
      </div>
    </div>
  )
}
