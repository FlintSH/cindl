/**
 * The exact Hermes v0.22.5 wire surface Cindl is allowed to use. The vendored
 * contract subset in upstream/v0.22.5 is extracted from these lists (see
 * scripts/extract-upstream.ts) and test/upstream.test.ts fails if any name the
 * adapter uses is missing upstream. Adding a name here is a contract change:
 * cite the upstream source and document it in the handbook reference.
 */

/** Legacy sidecar (desktop backend contract 8) JSON-RPC methods. */
export const sidecarMethods = [
  'client.capabilities',
  'gateway.capabilities',
  'ping',
  'session.create',
  'session.list',
  'session.active_list',
  'session.resume',
  'session.activate',
  'session.history',
  'session.status',
  'session.usage',
  'session.title',
  'session.archive',
  'session.events.since',
  'session.interrupt',
  'session.steer',
  'session.close',
  'session.most_recent',
  'prompt.submit',
  'approval.pending',
  'approval.respond',
  'request.answer',
  'subagent.list',
  'process.list',
  'cron.manage',
  'skills.manage',
  'mcp.servers.status',
  'profiles.describe',
  'profiles.list',
  'display.status',
  'display.observe',
  'display.lease.acquire',
  'display.lease.release',
] as const

/** Canonical session-authority methods (only when gateway.ready says session_authority). */
export const canonicalMethods = [
  'runtime.describe',
  'session.create',
  'session.list',
  'session.resume',
  'session.info',
  'session.events.since',
  'session.interrupt',
  'session.steer',
  'prompt.submit',
  'prompt.receipt',
  'prompt.resolve_unknown',
  'approval.respond',
  'clarify.respond',
  'profiles.list',
  'cron.status',
] as const

/** Server-to-client requests Cindl answers. Every other request gets JSON-RPC -32601. */
export const answeredServerRequests = ['approval', 'clarify'] as const

/** Notifications the normalizer understands. Unknown types are ignored, never guessed. */
export const handledNotifications = [
  'gateway.ready',
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'reasoning.delta',
  'reasoning.available',
  'thinking.delta',
  'tool.generating',
  'tool.start',
  'tool.progress',
  'tool.complete',
  'tool.output_risk',
  'status.update',
  'session.info',
  'session.usage',
  'session.title',
  'sessions.changed',
  'error',
  'notice',
  'request.cancel',
  'approval.cancelled',
  'background.complete',
  'cron.changed',
  'display.status',
  'display.lease',
  'subagent.start',
  'subagent.progress',
  'subagent.complete',
  'skills.changed',
  'session.reclaimed',
] as const

export type SidecarMethod = (typeof sidecarMethods)[number]
export type CanonicalMethod = (typeof canonicalMethods)[number]
export type HandledNotification = (typeof handledNotifications)[number]
