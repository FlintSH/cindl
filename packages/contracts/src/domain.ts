import { z } from 'zod'
import { CindlError } from './errors.ts'

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

/**
 * Question id. Hermes uses `q<index>` (tools/clarify_tool.py at v0.22.5).
 * `__proto__` is refused outright: a record keyed by it silently loses the
 * key, so an answer to it could never reach Hermes.
 */
const QuestionId = z
  .string()
  .min(1)
  .max(256)
  .refine((qid) => qid !== '__proto__', 'Unsupported question id')

export const ClarifyQuestion = z.object({
  qid: QuestionId,
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
  // Hermes allows choices up to 8,000 characters plus a " (Recommended)" suffix
  // (tools/clarify_tool.py at v0.22.5); every offered choice must be sendable.
  // Hermes counts code points; this counts UTF-16 units, so 16,384 admits every
  // offered choice even when it is written in astral characters (emoji).
  z.object({ choices: z.array(z.string().max(16_384)).min(1).max(50) }),
  z.object({ skipped: z.literal(true) }),
])
export type ClarifyResponse = z.infer<typeof ClarifyResponse>

/** An answer another client locked. It comes from Hermes, so only its shape is checked. */
export const LockedClarifyResponse = z.union([
  z.object({ text: z.string() }),
  z.object({ choices: z.array(z.string()) }),
  z.object({ skipped: z.literal(true) }),
])

/**
 * Hermes expects ONE reply for a whole clarify set: every open question must
 * appear in `answers` (answered or skipped). There is no decline: an empty
 * reply reaches the agent as `outcome: "cancelled"`, the same as an interrupt,
 * while skipping every question gives each a clean "skipped"
 * (tools/clarify_batch.py at v0.22.5).
 */
export const RequestAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), choice: ApprovalChoice }),
  z.object({
    kind: z.literal('clarify'),
    answers: z.record(QuestionId, ClarifyResponse),
  }),
])
export type RequestAnswer = z.infer<typeof RequestAnswer>

/**
 * Hermes server-request id, `srq-<12 hex>` (tui_gateway/server_requests.py at
 * v0.22.5): the JSON-RPC id of the request frame. Stable across reconnects
 * (Hermes re-sends with the same id) and answerable from any attached client;
 * the first reply wins.
 */
export const RequestId = z.string().regex(/^srq-[0-9a-f]{12}$/, 'Not a Hermes request id')
export type RequestId = z.infer<typeof RequestId>

/**
 * What an `unsupported` request asks for. Cindl never replies to these: any
 * reply, including a decline, an error or an empty skip, can become the value
 * Hermes uses. A unanimous 4404 settles a sidecar request with a JSON error
 * string that the secret callback may store and sudo or vault prompts may use
 * as the password or code (tui_gateway/server_requests.py, agent_callbacks.py
 * at v0.22.5). They stay open for another Hermes surface to answer. Unknown
 * request kinds are `other` and are treated the same way.
 */
export const UnsupportedRequestKind = z.enum(['sudo', 'secret', 'vault', 'other'])
export type UnsupportedRequestKind = z.infer<typeof UnsupportedRequestKind>

/**
 * A server-to-client request: a command approval, a clarifying question, or a
 * prompt Cindl does not answer (`unsupported`, shown so the owner knows Hermes
 * is waiting). Keyed by Hermes's request id, never by connection. It is not a
 * universal spending/sending policy engine.
 */
export const ServerRequest = z
  .object({
    requestId: RequestId,
    /** Hermes `request_id` inside approval params, when present (diagnostics only). */
    hermesApprovalId: z.string().optional(),
    /** Connection epoch on which this client last saw the request. Not identity. */
    lastSeenEpoch: z.number().int().nonnegative(),
    kind: z.enum(['approval', 'clarify', 'unsupported']),
    /** unsupported: what Hermes is asking for (missing means `other`). */
    unsupportedKind: UnsupportedRequestKind.optional(),
    /**
     * Hermes `session_id` of the frame. Approvals and questions always have one;
     * only `unsupported` prompts may be app-level (`display.install.sudo` arrives
     * with an empty `session_id`, tui_gateway/methods_display.py at v0.22.5).
     * Hermes sends such a prompt only to the connection that started the
     * operation, and lists every connection's open ones; Cindl starts none, so
     * the ones it shows belong to another Hermes surface.
     */
    conversationId: z.string().min(1).optional(),
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
    /**
     * Clarify: answers other clients already locked per question (`clarify.lock`,
     * replayed on reconnect). Cindl shows them and never overrides them.
     */
    lockedAnswers: z.record(z.string(), LockedClarifyResponse).optional(),
    receivedAt: isoTime,
    /**
     * open: waiting (answerable here unless `unsupported`). answering: this
     * client's answer is on its way. answered: Hermes acknowledged that it
     * accepted this client's answer; that is registry acceptance, not proof the
     * resulting action succeeded. resolved-elsewhere: it closed without an
     * acknowledged answer from this client (another surface answered, or it was
     * withdrawn). cancelled/expired: Hermes cancelled it or it timed out. A
     * closed request keeps `answer` if this client sent one. A failed send
     * returns it to open; there is no terminal failure. See the handbook's
     * server-requests reference for how each status is reached.
     */
    status: z.enum([
      'open',
      'answering',
      'answered',
      'resolved-elsewhere',
      'cancelled',
      'expired',
    ]),
    answer: RequestAnswer.optional(),
  })
  .refine(
    (request) => request.kind === 'unsupported' || Boolean(request.conversationId),
    {
      message: 'Approvals and questions belong to a conversation',
      path: ['conversationId'],
    },
  )
  .refine(
    (request) =>
      request.kind !== 'unsupported' ||
      (request.choices.length === 0 && !request.questions?.length),
    {
      message: 'A prompt Cindl does not answer offers nothing to answer',
      path: ['kind'],
    },
  )
export type ServerRequest = z.infer<typeof ServerRequest>

/** Questions still waiting for an answer: those no other client has locked. */
export function openQuestionIds(
  request: Pick<ServerRequest, 'questions' | 'lockedAnswers'>,
): string[] {
  const locked = request.lockedAnswers ?? {}
  return (request.questions ?? [])
    .map((q) => q.qid)
    .filter((qid) => !Object.hasOwn(locked, qid))
}

/**
 * True when `answers` covers exactly the open questions: every unlocked
 * question once, and no locked one (a reply's value would override a lock).
 */
/**
 * The single check every implementation runs before sending an answer:
 * prompts Cindl does not answer get nothing, not even a decline (ADR 0005).
 */
export function assertAnswerable(request: Pick<ServerRequest, 'kind'>): void {
  if (request.kind === 'unsupported')
    throw new CindlError(
      'unsupported',
      'Cindl does not answer this kind of prompt. Answer it in another Hermes surface.',
    )
}

export function clarifyAnswersComplete(
  request: Pick<ServerRequest, 'questions' | 'lockedAnswers'>,
  answers: Record<string, ClarifyResponse>,
): boolean {
  const open = openQuestionIds(request)
  const keys = Object.keys(answers)
  return (
    open.length > 0 &&
    keys.length === open.length &&
    open.every((qid) => Object.hasOwn(answers, qid))
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

/** Hermes's two memory stores: agent notes (MEMORY.md) and the user profile (USER.md). */
export const MemoryStore = z.enum(['memory', 'profile'])
export type MemoryStore = z.infer<typeof MemoryStore>

/**
 * A memory entry reference, `memory:<store>:<index>:<fingerprint>`, where the
 * fingerprint is the first 12 hex characters of `sha256(entry.trim())`
 * (agent/learning_mutations.py at v0.22.5). Hermes resolves the entry by its
 * fingerprint and refuses a write when the entry changed, so the id is also
 * the entry's version. Positional ids (no fingerprint) are refused: after any
 * change they can point at a different entry.
 */
export const MemoryEntryId = z
  .string()
  .regex(
    /^memory:(memory|profile):\d{1,6}:[a-f0-9]{12}$/,
    'Not a current memory entry reference',
  )
export type MemoryEntryId = z.infer<typeof MemoryEntryId>

/** One entry as Hermes lists it (GET /api/learning/graph). */
export const MemoryEntrySummary = z.object({
  id: MemoryEntryId,
  store: MemoryStore,
  title: z.string(),
  /** Hermes's card text: the entry, cut at 1,200 characters. */
  preview: z.string(),
  truncated: z.boolean(),
})
export type MemoryEntrySummary = z.infer<typeof MemoryEntrySummary>

/** One entry in full (GET /api/learning/node). */
export const MemoryEntry = z.object({
  id: MemoryEntryId,
  store: MemoryStore,
  content: z.string(),
  readAt: isoTime,
  source: z.string(),
})
export type MemoryEntry = z.infer<typeof MemoryEntry>

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
