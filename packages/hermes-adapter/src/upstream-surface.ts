/**
 * The exact Hermes v0.22.5 wire surface Cindl is allowed to use. The vendored
 * contract subset in upstream/v0.22.5 is extracted from these lists (see
 * scripts/extract-upstream.ts) and test/upstream.test.ts fails if any name the
 * adapter uses is missing upstream. Adding a name here is a contract change:
 * cite the upstream source and document it in the handbook reference.
 */

/**
 * Legacy sidecar (desktop backend contract 8) JSON-RPC methods: what a
 * standalone `hermes serve` offers on /api/ws (tui_gateway/ws.py:357-379).
 * Approvals and questions are answered with `request.answer` only; the
 * sidecar's `approval.respond` (oldest-first, with an `all` flag) is not used.
 */
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

/**
 * Canonical session-authority methods (only when gateway.ready says
 * session_authority, i.e. the gateway's own listener: gateway/run_api.py:63-71,
 * 366). Cindl negotiates this surface but implements no canonical sessions,
 * so the prompt_id-keyed `approval.respond` / `clarify.respond` are not listed.
 */
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
  'profiles.list',
  'cron.status',
] as const

/**
 * Server-to-client requests Cindl answers, through `request.answer`. Nothing
 * is ever sent for any other kind (sudo, secret, vault.*, unknown): no error,
 * no -32601, no empty value, because any reply settles the request for every
 * client and a credential prompt reads it as the answer. The one exception is
 * the 4404 vote for window-owned bridges on a sidecar that counts declines
 * (rpc.ts `unhandledRequestAction`).
 */
export const answeredServerRequests = ['approval', 'clarify'] as const

/** Notifications `normalize.ts` maps. Unknown types are ignored, never guessed. */
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
