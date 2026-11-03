import { z } from 'zod'

/**
 * Parsers for the Hermes v0.22.5 shapes Cindl reads. They are deliberately
 * narrower than upstream: `z.object` strips keys Cindl does not use, so host
 * paths (`/api/skills/content` `path`, loopback-only `/api/status` fields),
 * e-mail addresses and similar never travel further than this module.
 * Sources: hermes_cli/web_routers/*.py and the vendored contract subset.
 */

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

// --- REST ------------------------------------------------------------------

/** GET /api/status (web_routers/status.py:482-583, auth fields :383-405). */
export const StatusResponse = z.object({
  version: z.string().optional(),
  release_date: z.string().optional(),
  auth_required: z.boolean().optional(),
  auth_providers: z.array(z.string()).optional(),
  auth_flows: z.array(z.string()).optional(),
})
export type StatusResponse = z.infer<typeof StatusResponse>

/** GET /api/auth/providers (dashboard_auth/routes.py:203-213). */
export const ProvidersResponse = z.object({
  providers: z.array(
    z.object({
      name: z.string(),
      display_name: z.string().optional(),
      supports_password: z.boolean().optional(),
    }),
  ),
})
export type ProvidersResponse = z.infer<typeof ProvidersResponse>

/** GET /api/auth/me (routes.py:524-553). E-mail and org are dropped. */
export const MeResponse = z.object({
  user_id: z.string(),
  provider: z.string(),
  display_name: z.string().optional(),
  expires_at: z.number().optional(),
})
export type MeResponse = z.infer<typeof MeResponse>

/** POST /api/auth/ws-ticket (routes.py:556-564). */
export const WsTicketResponse = z.object({
  ticket: z.string().min(16),
  ttl_seconds: z.number(),
})

/** POST /auth/native/token and /auth/native/refresh (routes.py:111-117). */
export const NativeTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string(),
  expires_at: z.number(),
  provider: z.string(),
  user_id: z.string(),
})
export type NativeTokenResponse = z.infer<typeof NativeTokenResponse>

/** GET /api/sessions/{id}/mutation-snapshot (web_routers/sessions.py:586-598). */
export const MutationSnapshot = z.object({
  session_id: z.string(),
  exists: z.boolean(),
  runtime_revision: z.number().int(),
  runtime_generation: nullable(z.number().int()),
})
export type MutationSnapshot = z.infer<typeof MutationSnapshot>

/** PATCH /api/sessions/{id} (sessions.py:926-934 → hermes_state_runtime.py:544-546). */
export const SessionPatchResult = z.object({
  ok: z.literal(true),
  session_id: z.string().optional(),
  revision: z.number().optional(),
})

/** GET /api/skills (web_routers/skills.py:343-376). */
export const SkillsResponse = z.array(
  z.object({
    name: z.string().min(1),
    description: nullable(z.string()),
    category: nullable(z.string()),
    enabled: z.boolean().optional(),
    provenance: z.string().optional(),
  }),
)

/** GET /api/skills/content (skills.py:397-415). The host `path` is stripped. */
export const SkillContentResponse = z.object({ name: z.string(), content: z.string() })

/** PUT /api/skills/content (skills.py:433-444). */
export const SkillWriteResponse = z.object({ success: z.boolean().optional() })

/** GET /api/profiles/{name}/soul (web_routers/profiles.py:1000-1012). */
export const SoulResponse = z.object({ content: z.string(), exists: z.boolean() })

/** PUT /api/profiles/{name}/soul (profiles.py:1015-1034). */
export const SoulWriteResponse = z.object({ ok: z.boolean() })

/** GET /api/memory (web_routers/ops.py:494-509): sizes and providers only, no text. */
export const MemoryResponse = z.object({
  active: z.string().optional(),
  providers: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        available: z.boolean().optional(),
        missing: z.boolean().optional(),
      }),
    )
    .optional(),
  builtin_files: z
    .object({ memory: z.number().optional(), user: z.number().optional() })
    .optional(),
})
export type MemoryResponse = z.infer<typeof MemoryResponse>

/**
 * GET /api/learning/graph (agent/learning_graph.py:218-255): only the `memory`
 * cards are read; the skill graph is ignored. `body` is truncated to 1200
 * characters by Hermes; `fingerprint` is sha256(entry.strip())[:12].
 */
export const LearningGraphResponse = z.object({
  memory: z
    .array(
      z.object({
        source: z.enum(['memory', 'profile']),
        timestamp: nullable(z.number()),
        title: z.string(),
        body: z.string(),
        fingerprint: z.string().regex(/^[a-f0-9]{12}$/),
      }),
    )
    .optional(),
})
export type LearningGraphResponse = z.infer<typeof LearningGraphResponse>

/** GET /api/learning/node for a memory id (agent/learning_mutations.py:145-148). */
export const LearningNodeResponse = z.object({
  ok: z.literal(true),
  kind: z.literal('memory'),
  id: z.string(),
  content: z.string(),
})

/** PUT/DELETE /api/learning/node success (learning_mutations.py:85-119). */
export const LearningMutationResponse = z.object({
  ok: z.literal(true),
  message: z.string().optional(),
})

// --- JSON-RPC --------------------------------------------------------------

export const GatewayReadyPayload = z.object({
  change_events: z.boolean().optional(),
  replay_epoch: z.string().min(1),
  heartbeat: nullable(z.boolean()),
  session_authority: nullable(z.boolean()),
})
export type GatewayReadyPayload = z.infer<typeof GatewayReadyPayload>

export const ClientCapabilitiesResult = z.object({
  server_requests: z.array(z.string()),
  declines_not_shown: z.boolean().optional(),
})
export type ClientCapabilitiesResult = z.infer<typeof ClientCapabilitiesResult>

export const GatewayCapabilitiesResult = z.object({
  per_session_exclusive_submit: z.boolean(),
})

export const RuntimeDescribeResult = z.object({
  instance_id: z.string(),
  profile_id: z.string(),
  authority_epoch: z.number().int(),
  capabilities: z.array(z.string()),
})
export type RuntimeDescribeResult = z.infer<typeof RuntimeDescribeResult>

export const SessionListRow = z.object({
  id: z.string().min(1),
  resolved_id: nullable(z.string()),
  title: z.string().optional(),
  preview: z.string().optional(),
  started_at: z.number().optional(),
  message_count: z.number().int().optional(),
  source: z.string().optional(),
})
export type SessionListRow = z.infer<typeof SessionListRow>
export const SessionListResult = z.object({ sessions: z.array(SessionListRow) })

/** One transcript row (contract `TranscriptMessage`, additionalProperties allowed). */
export const TranscriptMessage = z.object({
  role: z.string(),
  text: nullable(z.string()),
  content: z.unknown().optional(),
  tool_call_id: nullable(z.string()),
  timestamp: nullable(z.number()),
  row_id: nullable(z.number().int()),
  name: nullable(z.string()),
  context: nullable(z.string()),
  reasoning: nullable(z.string()),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessage>

export const OpenRequestEntry = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
})
export type OpenRequestEntry = z.infer<typeof OpenRequestEntry>

const SessionInfo = z.object({
  title: z.string().optional(),
  running: z.boolean().optional(),
  stored_session_id: z.string().optional(),
})

export const SessionCreateResult = z.object({
  session_id: z.string().min(1),
  stored_session_id: z.string().min(1),
  message_count: z.number().int(),
  messages: z.array(TranscriptMessage).optional(),
  info: SessionInfo.optional(),
})

export const SessionResumeResult = z.object({
  session_id: z.string().min(1),
  stored_session_id: nullable(z.string()),
  message_count: z.number().int(),
  messages: z.array(TranscriptMessage),
  info: SessionInfo.optional(),
  running: nullable(z.boolean()),
  status: nullable(z.string()),
  open_requests: nullable(z.array(OpenRequestEntry)),
})
export type SessionResumeResult = z.infer<typeof SessionResumeResult>

export const SessionEventsSinceResult = z.object({
  events: z.array(z.record(z.string(), z.unknown())),
  latest_seq: z.number().int(),
  truncated: z.boolean(),
  count: z.number().int(),
  epoch: z.string(),
  open_requests: z.array(OpenRequestEntry),
})
export type SessionEventsSinceResult = z.infer<typeof SessionEventsSinceResult>

export const PromptSubmitResult = z.object({
  status: nullable(z.enum(['streaming', 'queued', 'steered', 'redirected'])),
  user_row_id: nullable(z.number().int()),
})

/** `request.answer` (tui_gateway/methods_prompt.py:1289-1302; RequestAnswerResult). */
export const RequestAnswerResult = z.object({ status: z.enum(['ok', 'expired']) })

export const SessionInterruptResult = z.object({
  status: z.enum(['interrupted', 'not_interrupted']),
})

export const CronJobRow = z.object({
  job_id: z.string().min(1),
  name: z.string().optional(),
  schedule: z.string().optional(),
  enabled: z.boolean().optional(),
  state: nullable(z.string()),
  next_run_at: nullable(z.string()),
  last_run_at: nullable(z.string()),
  last_status: nullable(z.string()),
})
export type CronJobRow = z.infer<typeof CronJobRow>

export const CronManageResult = z.object({
  success: nullable(z.boolean()),
  error: nullable(z.string()),
  jobs: nullable(z.array(CronJobRow)),
  job: nullable(CronJobRow),
})

export const McpServersStatusResult = z.object({
  servers: z.array(
    z.object({
      name: z.string().min(1),
      tools: z.number().int(),
      connected: z.boolean(),
      disabled: z.boolean(),
      status: z.string(),
    }),
  ),
  checked_at: z.number(),
})

export const DisplayLease = z.object({
  holder: z.enum(['agent', 'human']),
  viewer_hash: nullable(z.string()),
  since: z.number(),
  epoch: z.number().int(),
})
export type DisplayLease = z.infer<typeof DisplayLease>

export const DisplayStatus = z.object({
  /**
   * The profile the answer speaks for (contracts/display.py): the served
   * profile's name, `custom` for a home outside profiles/ (runtime.py:641-646).
   */
  profile: z.string().optional(),
  supported: z.boolean(),
  installed: z.boolean(),
  running: z.boolean(),
  lease: DisplayLease,
  profile_key: z.string(),
})
export type DisplayStatus = z.infer<typeof DisplayStatus>

export const DisplayObserveResult = DisplayStatus.extend({
  ticket: z.string().min(1),
  path: z.string(),
  viewer_id: z.string().min(1),
})

export const DisplayLeaseResult = z.object({ lease: DisplayLease })

/** Parse or return undefined; callers decide whether absence is an error. */
export function parseWire<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
