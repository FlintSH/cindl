import { z } from 'zod'

const isoTime = z.iso.datetime()

/**
 * Hermes distinguishes a stored session id (durable, in its session DB) from a
 * runtime id (a live agent in one gateway process). Never conflate them:
 * `session.resume` takes a stored id, `session.activate` a runtime id.
 */
export const SessionRef = z.object({
  storedId: z.string().min(1),
  runtimeId: z.string().min(1).optional(),
})
export type SessionRef = z.infer<typeof SessionRef>

/**
 * A conversation is one Hermes session. `main` is the device's pinned ongoing
 * conversation; Hermes v0.22.5 has no server-side pin, so the designation is
 * stored per device (see docs: guide/conversations).
 */
export const Conversation = z.object({
  id: z.string().min(1),
  session: SessionRef,
  title: z.string(),
  kind: z.enum(['main', 'side']),
  profile: z.string().optional(),
  createdAt: isoTime.optional(),
  updatedAt: isoTime.optional(),
  archived: z.boolean().optional(),
  /** Live state when known from this connection; `unknown` otherwise. */
  status: z.enum(['idle', 'working', 'waiting-on-you', 'unknown']),
  preview: z.string().optional(),
})
export type Conversation = z.infer<typeof Conversation>

export const ToolStatus = z.enum([
  'generating',
  'running',
  'complete',
  'error',
  'cancelled',
])
export type ToolStatus = z.infer<typeof ToolStatus>

/** Tool arguments and results can be private. Previews are redacted and truncated. */
export const ToolActivity = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  name: z.string(),
  title: z.string(),
  status: ToolStatus,
  startedAt: isoTime.optional(),
  endedAt: isoTime.optional(),
  progress: z.string().optional(),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  /** Hermes `tool.output_risk`: the output may contain risky content. */
  outputRisk: z.object({ level: z.string(), reason: z.string().optional() }).optional(),
})
export type ToolActivity = z.infer<typeof ToolActivity>

export const MessagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool'), toolId: z.string() }),
  z.object({
    type: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    text: z.string(),
  }),
])
export type MessagePart = z.infer<typeof MessagePart>

export const Message = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(MessagePart),
  status: z.enum(['streaming', 'complete', 'interrupted', 'error']),
  createdAt: isoTime.optional(),
  /** Unprompted assistant output (e.g. a routine), shown with its provenance. */
  origin: z.enum(['reply', 'proactive', 'routine', 'unknown']).optional(),
})
export type Message = z.infer<typeof Message>

/**
 * Hermes `prompt.submit` has no idempotency key. A prompt whose submission
 * outcome is unknown becomes `uncertain` and is never resent automatically.
 */
export const PromptState = z.enum([
  'queued-offline',
  'sending',
  'accepted',
  'uncertain',
  'failed',
])
export const PendingPrompt = z.object({
  clientId: z.string().min(1),
  conversationId: z.string().min(1),
  text: z.string().min(1),
  createdAt: isoTime,
  state: PromptState,
  /** Hermes disposition once accepted. */
  disposition: z.enum(['streaming', 'queued', 'steered', 'redirected']).optional(),
  error: z.string().optional(),
})
export type PendingPrompt = z.infer<typeof PendingPrompt>

/**
 * Hermes offers once / session / always / deny. Cindl answers only with `once`
 * or `deny`: standing grants are never issued from a Cindl client, and the
 * upstream `all` flag (answer every pending approval) is never sent.
 */
export const ApprovalChoice = z.enum(['once', 'deny'])
export type ApprovalChoice = z.infer<typeof ApprovalChoice>

export const ClarifyQuestion = z.object({
  qid: z.string().min(1),
  question: z.string(),
  choices: z.array(z.string()).optional(),
  multiSelect: z.boolean(),
})
export type ClarifyQuestion = z.infer<typeof ClarifyQuestion>

export const RequestAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), choice: ApprovalChoice }),
  z.object({
    kind: z.literal('clarify'),
    answers: z.record(
      z.string(),
      z.union([z.string().max(20_000), z.array(z.string().max(2_000))]),
    ),
  }),
  /** Clarify only: decline every question in the set. */
  z.object({ kind: z.literal('clarify-cancel') }),
])
export type RequestAnswer = z.infer<typeof RequestAnswer>

/**
 * A server-to-client request (a Hermes JSON-RPC request with an id). Cindl
 * answers it at most once, on the connection that received it, with a choice
 * Hermes actually offered. This covers command approvals and clarifying
 * questions; it is not a universal spending/sending policy engine.
 */
export const ServerRequest = z.object({
  /** JSON-RPC id of the request frame; answers reuse it. */
  rpcId: z.union([z.string(), z.number()]),
  /** Hermes `request_id` when present (approvals). */
  hermesRequestId: z.string().optional(),
  connectionEpoch: z.number().int().nonnegative(),
  kind: z.enum(['approval', 'clarify']),
  conversationId: z.string().optional(),
  title: z.string(),
  /** Approval: the command as Hermes redacted it server-side. */
  command: z.string().optional(),
  description: z.string().optional(),
  toolName: z.string().optional(),
  /** Approval: offered choices that Cindl can send; empty = answer elsewhere. */
  choices: z.array(ApprovalChoice),
  /** Approval: choices Hermes offered that Cindl deliberately does not send. */
  withheldChoices: z.array(z.string()).optional(),
  questions: z.array(ClarifyQuestion).optional(),
  receivedAt: isoTime,
  status: z.enum(['open', 'answering', 'answered', 'cancelled', 'expired', 'failed']),
  answer: RequestAnswer.optional(),
})
export type ServerRequest = z.infer<typeof ServerRequest>

export const RoutineRun = z.object({
  at: isoTime,
  status: z.enum(['ok', 'error', 'skipped', 'running', 'unknown']),
})
export const Routine = z.object({
  id: z.string().min(1),
  name: z.string(),
  schedule: z.string(),
  enabled: z.boolean(),
  lastRun: RoutineRun.optional(),
  nextRunAt: isoTime.optional(),
})
export type Routine = z.infer<typeof Routine>

export const Skill = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  enabled: z.boolean().optional(),
  source: z.string().optional(),
})
export type Skill = z.infer<typeof Skill>

/**
 * Editable text document read from Hermes (SOUL.md, a skill). `version` is a
 * SHA-256 of the content as read; writes require it (see ops `*.write`).
 */
export const VersionedDocument = z.object({
  key: z.string().min(1),
  content: z.string(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  readAt: isoTime,
  source: z.string(),
})
export type VersionedDocument = z.infer<typeof VersionedDocument>

/** Hermes v0.22.5 `GET /api/memory` returns metadata only; memory text is not exposed. */
export const MemoryOverview = z.object({
  items: z.array(
    z.object({ key: z.string(), label: z.string(), detail: z.string().optional() }),
  ),
  source: z.string(),
  readAt: isoTime,
})
export type MemoryOverview = z.infer<typeof MemoryOverview>

/** Cached MCP health. Server URLs and arguments are deliberately excluded. */
export const McpServerStatus = z.object({
  name: z.string().min(1),
  state: z.enum(['connected', 'connecting', 'error', 'disabled', 'unknown']),
  toolCount: z.number().int().nonnegative().optional(),
  checkedAt: isoTime.optional(),
  error: z.string().optional(),
})
export type McpServerStatus = z.infer<typeof McpServerStatus>

const Evidence = z.enum(['yes', 'no', 'unknown'])
/**
 * Account coverage keeps independent evidence separate: a stored credential is
 * not a signed-in browser session, and neither is an API-verified login.
 */
export const AccountCoverage = z.object({
  id: z.string().min(1),
  label: z.string(),
  credentialAvailable: Evidence,
  browserSignedIn: Evidence,
  apiVerified: Evidence,
  attention: z.enum([
    'none',
    'mfa-required',
    'expired',
    'reauth-required',
    'unsupported',
  ]),
  lastVerifiedAt: isoTime.optional(),
  source: z.string(),
})
export type AccountCoverage = z.infer<typeof AccountCoverage>

/** The agent-owned Linux screen of one Hermes profile, never other devices. */
export const DisplayState = z.object({
  status: z.enum(['running', 'stopped', 'unavailable', 'unknown']),
  controller: z.enum(['agent', 'you', 'another-viewer', 'none', 'unknown']),
  leaseHeldByThisDevice: z.boolean(),
  checkedAt: isoTime.optional(),
})
export type DisplayState = z.infer<typeof DisplayState>

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
})
export type Usage = z.infer<typeof Usage>
