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
 * stored per device (see conversations.setMain in
 * docs/handbook/reference/client-operations.md).
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

/**
 * One question's answer: `choices` for picked options (exactly one for a
 * single-select question), `text` for a typed answer, or `skipped`.
 */
export const ClarifyResponse = z.union([
  z.object({ text: z.string().trim().min(1).max(20_000) }),
  z.object({ choices: z.array(z.string().max(2_000)).min(1).max(50) }),
  z.object({ skipped: z.literal(true) }),
])
export type ClarifyResponse = z.infer<typeof ClarifyResponse>

/**
 * Hermes expects ONE reply for a whole clarify set: every question in the
 * request must appear in `answers` (answered or skipped). `clarify-cancel`
 * declines the whole set.
 */
export const RequestAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), choice: ApprovalChoice }),
  z.object({
    kind: z.literal('clarify'),
    answers: z.record(z.string().min(1).max(256), ClarifyResponse),
  }),
  z.object({ kind: z.literal('clarify-cancel') }),
])
export type RequestAnswer = z.infer<typeof RequestAnswer>

/**
 * Hermes server-request id (`srq-…`): the JSON-RPC id of the request frame.
 * Stable across reconnects (Hermes re-sends with the same id) and answerable
 * from any attached client; the first reply wins.
 */
export const RequestId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'Not a Hermes request id')
export type RequestId = z.infer<typeof RequestId>

/**
 * A server-to-client request: a command approval or a clarifying question.
 * Keyed by Hermes's request id, never by connection. It is not a universal
 * spending/sending policy engine.
 */
export const ServerRequest = z.object({
  requestId: RequestId,
  /** Hermes `request_id` inside approval params, when present (diagnostics only). */
  hermesApprovalId: z.string().optional(),
  /** Connection epoch on which this client last saw the request. Not identity. */
  lastSeenEpoch: z.number().int().nonnegative(),
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
  /**
   * answered: this client's answer was accepted. resolved-elsewhere: it closed
   * without this client's answer (another client answered, or Hermes timed it
   * out) as observed on reconnect.
   */
  status: z.enum([
    'open',
    'answering',
    'answered',
    'resolved-elsewhere',
    'cancelled',
    'expired',
    'failed',
  ]),
  answer: RequestAnswer.optional(),
})
export type ServerRequest = z.infer<typeof ServerRequest>

/** True when `answers` covers every question of the request exactly once. */
export function clarifyAnswersComplete(
  request: Pick<ServerRequest, 'questions'>,
  answers: Record<string, ClarifyResponse>,
): boolean {
  const qids = (request.questions ?? []).map((q) => q.qid)
  const keys = Object.keys(answers)
  return (
    qids.length > 0 &&
    keys.length === qids.length &&
    qids.every((qid) => Object.hasOwn(answers, qid))
  )
}

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

/**
 * `GET /api/memory` returns provider metadata only. Memory entries are a
 * separate Hermes surface (fingerprinted learning nodes) and capability.
 */
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
