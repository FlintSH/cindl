import { z } from 'zod'
import { CapabilityId, CapabilityMap } from './capabilities.ts'
import {
  AccountCoverage,
  Conversation,
  DisplayFrame,
  DisplayInputEvent,
  DisplayState,
  DisplayView,
  DisplayViewId,
  McpServerStatus,
  MemoryEntry,
  MemoryEntryId,
  MemoryEntrySummary,
  MemoryOverview,
  Message,
  PendingPrompt,
  RequestAnswer,
  RequestId,
  Routine,
  ServerRequest,
  Skill,
  ToolActivity,
  VersionedDocument,
} from './domain.ts'
import { CindlError } from './errors.ts'
import type { CindlEvent } from './events.ts'
import { LinkState } from './link.ts'

/**
 * Identifier charsets are deliberately narrow: values cross the Electron IPC
 * boundary and end up in Hermes URLs and RPC params. The adapter URL-encodes
 * them as well; these schemas stop hostile values (`../x`, `?a#b`, `%2e`) early.
 */
/** Hermes session ids look like `20260102_080000_ab12cd`; other opaque ids use the same charset. */
export const EntityId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'Not a valid id')
const entityId = EntityId
/** Client-generated ids (e.g. UUIDs). */
const clientId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'Not a valid client id')
/** Hermes profile names (hermes_cli/main.py at v0.22.5). */
export const ProfileName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Not a Hermes profile name')
/**
 * Skill names as Hermes lists them: a name or `category/name`, possibly with
 * spaces (hand-written frontmatter). Excluded: control characters, `\\`, `?`,
 * `#`, `%`, `..`, and leading or trailing `/` or spaces. Sent as a query value.
 */
export const SkillName = z
  .string()
  .max(200)
  .regex(
    // eslint-disable-next-line no-control-regex -- control characters are excluded on purpose
    /^(?!.*\.\.)(?! )(?!.* $)[^\x00-\x1f\x7f/\\?#%]+(?:\/[^\x00-\x1f\x7f/\\?#%]+)?$/,
    'Not a skill name',
  )

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

/**
 * A `hermes serve` origin Cindl may sign in to: https, or http only on the
 * loopback IP literals; no credentials, path, query or fragment. Normalised
 * to the bare origin, which is all a client stores.
 */
export const HermesOrigin = z
  .string()
  .max(2048)
  .transform((raw, ctx) => {
    const reject = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    if (/[?#\\\s]/.test(raw)) return reject('Use only the scheme, host and port.')
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return reject('Not a valid URL.')
    }
    if (url.username || url.password || raw.includes('@'))
      return reject('Remove credentials from the address.')
    if (url.pathname !== '/' && url.pathname !== '')
      return reject('Use only the scheme, host and port.')
    if (url.hostname.endsWith('.'))
      return reject('Remove the trailing dot from the host name.')
    if (url.port === '0') return reject('Port 0 is not a usable port.')
    if (url.protocol === 'https:') return url.origin
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin
    return reject('Use https:// (plain http is allowed only for 127.0.0.1 or [::1]).')
  })

const version = VersionedDocument.shape.version
/** Owner edits must carry an explicit confirmation produced by a review step. */
const confirmed = z.literal(true)

interface OpDefinition<A extends z.ZodType, R extends z.ZodType> {
  args: A
  result: R
  /** Capability that must be usable before the op is attempted. */
  capability?: CapabilityId
  /** Changes state on the Hermes host (or this device's sign-in). */
  mutates: boolean
  summary: string
}
const op = <A extends z.ZodType, R extends z.ZodType>(definition: OpDefinition<A, R>) =>
  definition

/**
 * The complete operation surface a Cindl UI may call. Platforms implement it
 * directly (web, Android) or over IPC (Electron renderer -> main), where the
 * main process validates `args` with these schemas before anything reaches
 * Hermes. There is deliberately no generic RPC or REST passthrough.
 *
 * Implementations must also emit the CindlEvents implied by an op's result
 * (e.g. `conversations.history` emits `history.loaded`), so every store fed by
 * `subscribe` converges without UI code writing to it directly.
 */
export const clientOps = {
  'link.get': op({
    args: z.object({}),
    result: LinkState,
    mutates: false,
    summary: 'Current connection state.',
  }),
  'capabilities.get': op({
    args: z.object({}),
    result: CapabilityMap,
    mutates: false,
    summary: 'Negotiated capabilities for this connection.',
  }),
  'auth.signIn': op({
    args: z.object({ origin: HermesOrigin }),
    result: LinkState,
    mutates: true,
    summary:
      'Sign in to a hermes serve origin with the platform flow (native PKCE or same-origin login).',
  }),
  'auth.signOut': op({
    args: z.object({}),
    result: z.object({ localOnly: z.literal(true) }),
    mutates: true,
    summary:
      'Forget this device’s tokens. Hermes v0.22.5 cannot revoke issued native tokens remotely.',
  }),
  'conversations.list': op({
    args: z.object({ includeArchived: z.boolean().optional() }),
    result: z.array(Conversation),
    capability: 'sessions.list',
    mutates: false,
    summary: 'Hermes sessions for the active profile.',
  }),
  'conversations.create': op({
    args: z.object({ title: z.string().max(200).optional() }),
    result: Conversation,
    capability: 'sessions.create',
    mutates: true,
    summary: 'Start a side conversation.',
  }),
  'conversations.setMain': op({
    args: z.object({ conversationId: entityId }),
    result: Conversation,
    mutates: false,
    summary: 'Pin the device’s main conversation (stored on this device).',
  }),
  'conversations.rename': op({
    args: z.object({
      conversationId: entityId,
      title: z.string().trim().min(1).max(200),
    }),
    result: Conversation,
    capability: 'sessions.rename',
    mutates: true,
    summary: 'Rename a conversation in Hermes.',
  }),
  'conversations.history': op({
    args: z.object({ conversationId: entityId }),
    result: z.object({ messages: z.array(Message), tools: z.array(ToolActivity) }),
    capability: 'sessions.history',
    mutates: false,
    summary: 'Stored transcript for a conversation.',
  }),
  'prompt.submit': op({
    args: z.object({
      conversationId: entityId,
      clientId,
      text: z.string().min(1).max(100_000),
    }),
    result: PendingPrompt,
    capability: 'chat.stream',
    mutates: true,
    summary: 'Send a message. Never retried automatically once its outcome is uncertain.',
  }),
  'prompt.discard': op({
    args: z.object({ clientId }),
    result: z.object({ discarded: z.boolean() }),
    mutates: false,
    summary: 'Drop a queued or uncertain local prompt without sending it.',
  }),
  'conversation.interrupt': op({
    args: z.object({ conversationId: entityId }),
    result: z.object({ requested: z.literal(true) }),
    capability: 'chat.interrupt',
    mutates: true,
    summary: 'Ask Hermes to stop the current turn.',
  }),
  'request.answer': op({
    args: z.object({
      requestId: RequestId,
      answer: RequestAnswer,
    }),
    result: ServerRequest,
    mutates: true,
    summary:
      'Answer one open approval or clarify request once (never an unsupported one); clarify sets are answered in one submission.',
  }),
  'routines.list': op({
    args: z.object({}),
    result: z.array(Routine),
    capability: 'routines.read',
    mutates: false,
    summary: 'Scheduled Hermes cron jobs.',
  }),
  'routines.setEnabled': op({
    args: z.object({ id: entityId, enabled: z.boolean(), confirm: confirmed }),
    result: Routine,
    capability: 'routines.write',
    mutates: true,
    summary: 'Pause or resume a cron job.',
  }),
  'skills.list': op({
    args: z.object({}),
    result: z.array(Skill),
    capability: 'skills.read',
    mutates: false,
    summary: 'Installed skills.',
  }),
  'skills.read': op({
    args: z.object({ name: SkillName }),
    result: VersionedDocument,
    capability: 'skills.read',
    mutates: false,
    summary: 'A skill’s SKILL.md content.',
  }),
  'skills.write': op({
    args: z.object({
      name: SkillName,
      content: z.string().max(500_000),
      expectedVersion: version,
      confirm: confirmed,
    }),
    result: VersionedDocument,
    capability: 'skills.write',
    mutates: true,
    summary:
      'Replace a skill’s content after a reviewed diff; rejected if it changed since read.',
  }),
  'soul.read': op({
    args: z.object({ profile: ProfileName.optional() }),
    result: VersionedDocument,
    capability: 'soul.read',
    mutates: false,
    summary: 'The profile’s SOUL.md.',
  }),
  'soul.write': op({
    args: z.object({
      profile: ProfileName.optional(),
      content: z.string().max(200_000),
      expectedVersion: version,
      confirm: confirmed,
    }),
    result: VersionedDocument,
    capability: 'soul.write',
    mutates: true,
    summary: 'Replace SOUL.md after a reviewed diff; rejected if it changed since read.',
  }),
  'memory.overview': op({
    args: z.object({}),
    result: MemoryOverview,
    capability: 'memory.overview',
    mutates: false,
    summary:
      'Memory provider metadata (GET /api/memory). Entries are a separate capability.',
  }),
  'memory.entries': op({
    args: z.object({}),
    result: z.array(MemoryEntrySummary),
    capability: 'memory.text',
    mutates: false,
    summary: 'Memory entries (agent notes and the user profile) as Hermes lists them.',
  }),
  'memory.read': op({
    args: z.object({ id: MemoryEntryId }),
    result: MemoryEntry,
    capability: 'memory.text',
    mutates: false,
    summary: 'One memory entry in full.',
  }),
  'memory.write': op({
    args: z.object({
      id: MemoryEntryId,
      // A sanity bound only: Hermes enforces each profile's own limit
      // (default 2,200 for agent notes, 1,375 for the profile).
      content: z.string().trim().min(1).max(20_000),
      confirm: confirmed,
    }),
    result: MemoryEntry,
    capability: 'memory.text',
    mutates: true,
    summary:
      'Replace one entry after a reviewed diff; refused if it changed since it was read (its id is its version).',
  }),
  'memory.delete': op({
    args: z.object({ id: MemoryEntryId, confirm: confirmed }),
    result: z.object({ deleted: z.literal(true) }),
    capability: 'memory.text',
    mutates: true,
    summary: 'Delete one entry. Permanent: Hermes keeps no backup.',
  }),
  'connections.mcp': op({
    args: z.object({}),
    result: z.array(McpServerStatus),
    capability: 'connections.mcp',
    mutates: false,
    summary: 'Cached MCP server health (read-only; does not probe).',
  }),
  'connections.accounts': op({
    args: z.object({}),
    result: z.array(AccountCoverage),
    capability: 'connections.accounts',
    mutates: false,
    summary: 'Account coverage evidence, when a safe source exists.',
  }),
  'display.status': op({
    args: z.object({}),
    result: DisplayState,
    capability: 'computer.view',
    mutates: false,
    summary: 'State of the agent-owned screen. Never starts it.',
  }),
  'display.acquireControl': op({
    args: z.object({ confirm: confirmed }),
    result: DisplayState,
    capability: 'computer.control',
    mutates: true,
    summary: 'Take the input lease for the agent-owned screen.',
  }),
  'display.releaseControl': op({
    args: z.object({}),
    result: DisplayState,
    capability: 'computer.control',
    mutates: true,
    summary: 'Return the input lease.',
  }),
  'display.watch': op({
    args: z.object({}),
    result: DisplayView,
    capability: 'computer.view',
    mutates: false,
    summary: 'Start showing the agent-owned screen. Never starts the screen.',
  }),
  'display.frame': op({
    args: z.object({ viewId: DisplayViewId }),
    result: DisplayFrame,
    capability: 'computer.view',
    mutates: false,
    summary:
      'What changed on the screen since the last call; waits a few seconds for a change.',
  }),
  'display.unwatch': op({
    args: z.object({ viewId: DisplayViewId }),
    result: z.object({ stopped: z.boolean() }),
    capability: 'computer.view',
    mutates: false,
    summary: 'Stop showing the screen.',
  }),
  'display.input': op({
    args: z.object({
      viewId: DisplayViewId,
      events: z.array(DisplayInputEvent).min(1).max(64),
    }),
    result: z.object({ sent: z.number().int().nonnegative() }),
    capability: 'computer.control',
    mutates: true,
    summary:
      'Pointer and key input, sent only while this device holds control. Never logged.',
  }),
} as const

export type ClientOps = typeof clientOps
export type OpName = keyof ClientOps
export type OpArgs<K extends OpName> = z.input<ClientOps[K]['args']>
export type OpResult<K extends OpName> = z.output<ClientOps[K]['result']>
export const opNames = Object.keys(clientOps) as OpName[]

/** What every Cindl UI codes against, on every platform. */
export interface CindlClientApi {
  call<K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>>
  subscribe(listener: (event: CindlEvent) => void): () => void
}

/**
 * Validate untrusted op input (IPC boundary). Throws `CindlError('invalid')`:
 * nothing was sent, so callers can say so rather than report an uncertain
 * outcome. `detail` names the failing field and rule, never its value.
 */
export function parseOpArgs<K extends OpName>(
  name: K,
  args: unknown,
): z.output<ClientOps[K]['args']> {
  if (!isOpName(name))
    throw new CindlError('invalid', 'Not sent: unknown operation.', 'unknown op name')
  const result = clientOps[name].args.safeParse(args)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new CindlError(
      'invalid',
      `Not sent: ${describeIssue(issue)}`,
      `${name}: ${issue ? `${issue.path.join('.') || '(args)'} ${issue.code}` : 'invalid'}`,
    )
  }
  return result.data as z.output<ClientOps[K]['args']>
}

function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (issue?.code === 'too_big' && issue.origin === 'string')
    return `the text is longer than ${Number(issue.maximum).toLocaleString('en-US')} characters.`
  if (issue?.code === 'too_big' && issue.origin === 'array')
    return `there are more than ${Number(issue.maximum).toLocaleString('en-US')} items.`
  return 'Cindl rejected this request before sending it.'
}

export function isOpName(value: unknown): value is OpName {
  return typeof value === 'string' && Object.hasOwn(clientOps, value)
}
