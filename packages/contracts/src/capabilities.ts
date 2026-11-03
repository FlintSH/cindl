import { z } from 'zod'

/**
 * Everything a client can show or do. A capability is never assumed: the
 * adapter negotiates or probes it per connection and reports its state with
 * provenance. The UI renders unavailable and unsupported states explicitly.
 */
export const capabilityIds = [
  'chat.stream',
  'chat.interrupt',
  'chat.steer',
  'sessions.list',
  'sessions.create',
  'sessions.history',
  'sessions.replay',
  'sessions.rename',
  'requests.approval',
  'requests.clarify',
  'activity.tools',
  'activity.subagents',
  'activity.processes',
  'routines.read',
  'routines.write',
  'skills.read',
  'skills.write',
  'soul.read',
  'soul.write',
  'memory.overview',
  'memory.text',
  'connections.mcp',
  'connections.accounts',
  'computer.view',
  'computer.control',
  'artifacts.list',
  'attachments.upload',
  'presence.unified',
] as const

export const CapabilityId = z.enum(capabilityIds)
export type CapabilityId = z.infer<typeof CapabilityId>

/**
 * - available: negotiated or probed successfully on this connection.
 * - limited: usable with a documented limitation (see `reason`).
 * - unavailable: this Hermes version supports it, but not right now
 *   (signed out, offline, screen stopped, not permitted).
 * - unsupported: this Hermes version or transport does not expose it.
 * - unknown: not checked yet. Never rendered as working.
 */
export const CapabilityState = z.enum([
  'available',
  'limited',
  'unavailable',
  'unsupported',
  'unknown',
])
export type CapabilityState = z.infer<typeof CapabilityState>

export const CapabilitySource = z.object({
  /** How the state was established. `none` = nothing was contacted. */
  transport: z.enum(['rest', 'rpc', 'derived', 'none']),
  /** REST path or RPC method that established it, e.g. `GET /api/status`. */
  endpoint: z.string().optional(),
  hermesVersion: z.string().optional(),
})
export type CapabilitySource = z.infer<typeof CapabilitySource>

export const Capability = z.object({
  id: CapabilityId,
  state: CapabilityState,
  /** Human-readable explanation; required for anything but `available`. */
  reason: z.string().optional(),
  source: CapabilitySource,
  checkedAt: z.iso.datetime().optional(),
})
export type Capability = z.infer<typeof Capability>

/** Partial by design: absent means `unknown`, never `available`. */
export const CapabilityMap = z.partialRecord(CapabilityId, Capability)
export type CapabilityMap = z.infer<typeof CapabilityMap>

export function capabilityUsable(capability: Capability | undefined): boolean {
  return capability?.state === 'available' || capability?.state === 'limited'
}
