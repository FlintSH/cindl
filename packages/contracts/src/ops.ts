import { z } from 'zod'
import { CapabilityId, CapabilityMap } from './capabilities.ts'
import {
  AccountCoverage,
  Conversation,
  DisplayState,
  McpServerStatus,
  MemoryOverview,
  Message,
  PendingPrompt,
  RequestAnswer,
  Routine,
  ServerRequest,
  Skill,
  ToolActivity,
  VersionedDocument,
} from './domain.ts'
import type { CindlEvent } from './events.ts'
import { LinkState } from './link.ts'

const id = z.string().min(1).max(512)
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
    args: z.object({ origin: z.url({ protocol: /^https?$/ }) }),
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
    args: z.object({ conversationId: id }),
    result: Conversation,
    mutates: false,
    summary: 'Pin the device’s main conversation (stored on this device).',
  }),
  'conversations.rename': op({
    args: z.object({ conversationId: id, title: z.string().min(1).max(200) }),
    result: Conversation,
    capability: 'sessions.rename',
    mutates: true,
    summary: 'Rename a conversation in Hermes.',
  }),
  'conversations.history': op({
    args: z.object({ conversationId: id }),
    result: z.object({ messages: z.array(Message), tools: z.array(ToolActivity) }),
    capability: 'sessions.history',
    mutates: false,
    summary: 'Stored transcript for a conversation.',
  }),
  'prompt.submit': op({
    args: z.object({
      conversationId: id,
      clientId: id,
      text: z.string().min(1).max(100_000),
    }),
    result: PendingPrompt,
    capability: 'chat.stream',
    mutates: true,
    summary: 'Send a message. Never retried automatically once its outcome is uncertain.',
  }),
  'prompt.discard': op({
    args: z.object({ clientId: id }),
    result: z.object({ discarded: z.boolean() }),
    mutates: false,
    summary: 'Drop a queued or uncertain local prompt without sending it.',
  }),
  'conversation.interrupt': op({
    args: z.object({ conversationId: id }),
    result: z.object({ requested: z.literal(true) }),
    capability: 'chat.interrupt',
    mutates: true,
    summary: 'Ask Hermes to stop the current turn.',
  }),
  'request.answer': op({
    args: z.object({
      rpcId: z.union([z.string().min(1), z.number()]),
      connectionEpoch: z.number().int().nonnegative(),
      answer: RequestAnswer,
    }),
    result: ServerRequest,
    mutates: true,
    summary: 'Answer one open server request, once, with an offered choice.',
  }),
  'routines.list': op({
    args: z.object({}),
    result: z.array(Routine),
    capability: 'routines.read',
    mutates: false,
    summary: 'Scheduled Hermes cron jobs.',
  }),
  'routines.setEnabled': op({
    args: z.object({ id, enabled: z.boolean(), confirm: confirmed }),
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
    args: z.object({ name: id }),
    result: VersionedDocument,
    capability: 'skills.read',
    mutates: false,
    summary: 'A skill’s SKILL.md content.',
  }),
  'skills.write': op({
    args: z.object({
      name: id,
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
    args: z.object({ profile: id.optional() }),
    result: VersionedDocument,
    capability: 'soul.read',
    mutates: false,
    summary: 'The profile’s SOUL.md.',
  }),
  'soul.write': op({
    args: z.object({
      profile: id.optional(),
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
    summary: 'Memory metadata. Memory text is not exposed by Hermes v0.22.5.',
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

/** Validate untrusted op input (IPC boundary). Throws a ZodError on mismatch. */
export function parseOpArgs<K extends OpName>(
  name: K,
  args: unknown,
): z.output<ClientOps[K]['args']> {
  const definition = clientOps[name] as ClientOps[OpName] | undefined
  if (!definition) throw new Error(`Unknown Cindl operation: ${String(name)}`)
  return definition.args.parse(args) as z.output<ClientOps[K]['args']>
}

export function isOpName(value: unknown): value is OpName {
  return typeof value === 'string' && Object.hasOwn(clientOps, value)
}
