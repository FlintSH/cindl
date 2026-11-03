import {
  capabilityIds,
  type Capability,
  type CapabilityId,
  type CapabilityMap,
  type CapabilitySource,
  type CapabilityState,
} from '@cindl/contracts'
import type { Handshake } from './connection.ts'
import type { DisplayStatus, StatusResponse } from './wire.ts'

/**
 * Capability negotiation for one connection (ADR 0004). Inputs are only what
 * Cindl learned without changing anything on the host: public discovery
 * (`GET /api/status`), the WebSocket handshake (`gateway.ready`,
 * `client.capabilities`, `gateway.capabilities` or `runtime.describe`) and
 * read-only probes such as `display.status`. Nothing is assumed: a capability
 * with no evidence is left out (unknown), and every state but `available`
 * carries its reason.
 */
export interface NegotiationInput {
  checkedAt: string
  hermesVersion?: string
  status?: StatusResponse
  /** Signed in (cookie session verified or native tokens present). */
  signedIn: boolean
  /** The handshake of the current connection, when online. */
  handshake?: Handshake
  /** Why the connection is not online, when it is not. */
  offlineReason?: string
  /** `display.status` result; undefined when not probed or the probe failed. */
  display?: Pick<DisplayStatus, 'supported' | 'installed' | 'running'>
}

/** Fixed v0.22.5 facts, independent of the connection. */
export const unsupportedReasons = {
  'memory.text':
    'Hermes v0.22.5 exposes single memory entries through /api/learning/*, but Cindl has no reviewed operation for them yet (contract change pending). Cindl never reads memory files through filesystem routes.',
  'connections.accounts':
    'Hermes v0.22.5 has no safe account-coverage source. Its connectors.* calls can create guest identities, so Cindl does not use them.',
  'artifacts.list':
    'Hermes v0.22.5 has no artifact listing API; its desktop app derives artifacts client-side.',
  'attachments.upload':
    'Not implemented in Cindl. Hermes v0.22.5 has file.attach, which Cindl does not wire yet.',
  'chat.steer':
    'Not wired in Cindl yet. Hermes v0.22.5 has session.steer; Cindl has no operation for it.',
  'activity.processes':
    'Not wired in Cindl yet. Hermes v0.22.5 has process.list; Cindl has no operation for it.',
} as const satisfies Partial<Record<CapabilityId, string>>

const noCas =
  'Hermes v0.22.5 replaces the whole file with no server-side compare-and-swap or backup. Cindl re-reads and compares the SHA-256 first, which narrows but cannot close the race.'

const rpc = (endpoint: string, hermesVersion?: string): CapabilitySource => ({
  transport: 'rpc',
  endpoint,
  ...(hermesVersion ? { hermesVersion } : {}),
})
const rest = (endpoint: string, hermesVersion?: string): CapabilitySource => ({
  transport: 'rest',
  endpoint,
  ...(hermesVersion ? { hermesVersion } : {}),
})
const none: CapabilitySource = { transport: 'none' }

export function negotiateCapabilities(input: NegotiationInput): CapabilityMap {
  const map: CapabilityMap = {}
  const version = input.hermesVersion ?? input.status?.version
  const set = (
    id: CapabilityId,
    state: CapabilityState,
    source: CapabilitySource,
    reason?: string,
  ) => {
    const capability: Capability = {
      id,
      state,
      source,
      checkedAt: input.checkedAt,
      ...(reason ? { reason } : {}),
    }
    map[id] = capability
  }

  for (const [id, reason] of Object.entries(unsupportedReasons))
    set(id as CapabilityId, 'unsupported', none, reason)

  const handshake = input.handshake
  const offline =
    input.offlineReason ??
    (!input.signedIn ? 'Sign in to Hermes first.' : 'Not connected to Hermes right now.')

  // REST-backed reads and writes need a session, not the WebSocket.
  const restGate = (id: CapabilityId, endpoint: string, limitedReason?: string) => {
    if (!input.signedIn) set(id, 'unavailable', rest(endpoint, version), offline)
    else
      set(
        id,
        limitedReason ? 'limited' : 'available',
        rest(endpoint, version),
        limitedReason,
      )
  }
  restGate('skills.read', 'GET /api/skills')
  restGate('skills.write', 'PUT /api/skills/content', noCas)
  restGate('soul.read', 'GET /api/profiles/{name}/soul')
  restGate('soul.write', 'PUT /api/profiles/{name}/soul', noCas)
  restGate('memory.overview', 'GET /api/memory')
  restGate('sessions.rename', 'PATCH /api/sessions/{id}', undefined)

  const rpcIds: CapabilityId[] = [
    'chat.stream',
    'chat.interrupt',
    'sessions.list',
    'sessions.create',
    'sessions.history',
    'sessions.replay',
    'requests.approval',
    'requests.clarify',
    'activity.tools',
    'activity.subagents',
    'routines.read',
    'routines.write',
    'connections.mcp',
    'computer.view',
    'computer.control',
  ]

  if (!handshake) {
    for (const id of rpcIds) set(id, 'unavailable', none, offline)
    set('presence.unified', 'unavailable', none, offline)
    return fillUnknown(map)
  }

  if (handshake.authority === 'canonical') {
    // runtime.describe answered, but Cindl's canonical session path is not
    // implemented; it never falls back to sidecar methods on this socket.
    const reason =
      'Hermes reported session_authority (canonical protocol). Cindl negotiated runtime.describe but does not implement canonical sessions yet, and never mixes them with sidecar methods. hermes serve v0.22.5 does not offer this mode.'
    for (const id of rpcIds)
      set(id, 'unsupported', rpc('runtime.describe', version), reason)
    set(
      'presence.unified',
      'unavailable',
      rpc('runtime.describe', version),
      'The handshake proved one session authority, but Cindl cannot use the canonical protocol yet.',
    )
    return fillUnknown(map)
  }

  set('chat.stream', 'available', rpc('prompt.submit', version))
  set('chat.interrupt', 'available', rpc('session.interrupt', version))
  set('sessions.list', 'available', rpc('session.list', version))
  set('sessions.create', 'available', rpc('session.create', version))
  set('sessions.history', 'available', rpc('session.resume', version))
  set(
    'sessions.replay',
    'limited',
    rpc('session.events.since', version),
    'Bounded in-memory replay (512 events or 4 MiB per session) that a Hermes restart discards; Cindl reloads history when it cannot trust the replay.',
  )
  for (const [id, method] of [
    ['requests.approval', 'approval'],
    ['requests.clarify', 'clarify'],
  ] as const)
    if (handshake.serverRequests.includes(method))
      set(id, 'available', rpc(`client.capabilities → ${method}`, version))
    else
      set(
        id,
        'unavailable',
        rpc('client.capabilities', version),
        `Hermes did not offer ${method} requests on this connection.`,
      )
  set('activity.tools', 'available', rpc('tool.* events', version))
  set('activity.subagents', 'available', rpc('subagent.* events', version))
  set('routines.read', 'available', rpc('cron.manage', version))
  set('routines.write', 'available', rpc('cron.manage', version))
  set('connections.mcp', 'available', rpc('mcp.servers.status', version))
  set(
    'presence.unified',
    'unavailable',
    rpc('gateway.ready', version),
    'This hermes serve connection uses the legacy sidecar without session_authority, so one live session across every surface is not proven.',
  )

  const display = input.display
  if (!display) {
    // Not probed: leave computer.* unknown rather than guess.
    delete map['computer.view']
    delete map['computer.control']
  } else if (!display.supported || !display.installed) {
    const reason = !display.supported
      ? 'This Hermes host does not support the agent screen.'
      : 'The agent screen is not installed on this Hermes host. Cindl never installs it.'
    set('computer.view', 'unsupported', rpc('display.status', version), reason)
    set('computer.control', 'unsupported', rpc('display.status', version), reason)
  } else if (!display.running) {
    const reason = 'The agent screen is not running. Cindl never starts it.'
    set('computer.view', 'unavailable', rpc('display.status', version), reason)
    set('computer.control', 'unavailable', rpc('display.status', version), reason)
  } else {
    set(
      'computer.view',
      'limited',
      rpc('display.status', version),
      'Cindl shows the screen state and who controls it; the live picture (display.observe RFB stream) is not exposed through Cindl yet.',
    )
    set('computer.control', 'available', rpc('display.lease.acquire', version))
  }
  return fillUnknown(map)
}

/** Keep the map partial: ids without evidence stay absent (= unknown). */
function fillUnknown(map: CapabilityMap): CapabilityMap {
  const ordered: CapabilityMap = {}
  for (const id of capabilityIds) if (map[id]) ordered[id] = map[id]
  return ordered
}
