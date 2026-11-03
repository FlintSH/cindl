import { z } from 'zod'
import { CapabilityMap } from './capabilities.ts'
import {
  Conversation,
  DisplayState,
  Message,
  PendingPrompt,
  RequestAnswer,
  ServerRequest,
  ToolActivity,
  Usage,
} from './domain.ts'
import { LinkState } from './link.ts'

/**
 * Normalized events the adapter emits and client stores reduce. Hermes wire
 * events (message.delta, tool.start, ...) never reach UI code directly.
 */
export const CindlEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('link.changed'), link: LinkState }),
  z.object({ type: z.literal('capabilities.changed'), capabilities: CapabilityMap }),
  z.object({ type: z.literal('conversation.upserted'), conversation: Conversation }),
  z.object({ type: z.literal('conversation.removed'), conversationId: z.string() }),
  z.object({
    type: z.literal('history.loaded'),
    conversationId: z.string(),
    messages: z.array(Message),
  }),
  z.object({
    type: z.literal('history.reset'),
    conversationId: z.string(),
    reason: z.enum(['epoch-changed', 'truncated', 'resync']),
  }),
  z.object({
    type: z.literal('message.started'),
    conversationId: z.string(),
    messageId: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
  }),
  z.object({
    type: z.literal('message.delta'),
    conversationId: z.string(),
    messageId: z.string(),
    kind: z.enum(['text', 'reasoning']),
    text: z.string(),
  }),
  z.object({
    type: z.literal('message.completed'),
    conversationId: z.string(),
    messageId: z.string(),
    status: z.enum(['complete', 'interrupted', 'error']),
    /** Authoritative final text if Hermes sent one; replaces streamed deltas. */
    text: z.string().optional(),
  }),
  z.object({ type: z.literal('tool.updated'), activity: ToolActivity }),
  z.object({ type: z.literal('prompt.updated'), prompt: PendingPrompt }),
  /**
   * Hermes holds this request open: a live request frame, or Hermes's list of
   * open requests after (re)connect. Never emitted from history replay.
   * Implementations also emit it for their own `answering` transition, with
   * `lastSeenEpoch` set to the connection the answer is sent on.
   * Hermes re-sends only open requests, so a re-send with a higher
   * `lastSeenEpoch` reopens the request whatever this client last knew.
   */
  z.object({ type: z.literal('request.opened'), request: ServerRequest }),
  /**
   * The request is no longer open. After `request.answer`, an implementation
   * ends `answering` with exactly one of: this event with `answered` when
   * Hermes acknowledged the answer (it accepted it; the resulting action may
   * still fail), this event with `resolved-elsewhere` when Hermes says the
   * request was no longer pending, or `request.answer-failed`. Hermes's own
   * closes (cancelled, expired, resolved) carry their status as is. An
   * `answered` acknowledgement that arrives after a `resolved-elsewhere` close
   * still records `answered`.
   */
  z.object({
    type: z.literal('request.closed'),
    requestId: z.string(),
    status: z.enum(['answered', 'resolved-elsewhere', 'cancelled', 'expired']),
    /**
     * With `answered`: the answer Hermes acknowledged. It wins over any later
     * local attempt, because Hermes keeps the first answer it accepted.
     */
    answer: RequestAnswer.optional(),
    /** When this close is the outcome of this client's attempt: the epoch it was sent on. */
    connectionEpoch: z.number().int().nonnegative().optional(),
  }),
  /**
   * After (re)connect: one event for every conversation that has open
   * requests on either side, listing what Hermes still holds open there. That
   * conversation's other open or answering requests close as
   * `resolved-elsewhere`; Hermes cannot say whose answer it used.
   */
  z.object({
    type: z.literal('requests.synced'),
    conversationId: z.string(),
    openRequestIds: z.array(z.string()),
    /** The connection the list came from; it cannot close a request seen on a newer one. */
    connectionEpoch: z.number().int().nonnegative().optional(),
  }),
  /**
   * This client's answer did not reach Hermes, or Hermes rejected it and still
   * holds the request open: it is answerable again.
   */
  z.object({
    type: z.literal('request.answer-failed'),
    requestId: z.string(),
    /** The epoch the failed attempt was sent on; an older attempt cannot unlock a newer one. */
    connectionEpoch: z.number().int().nonnegative().optional(),
  }),
  /** A local prompt record (queued or uncertain) was dismissed or delivered. */
  z.object({ type: z.literal('prompt.removed'), clientId: z.string() }),
  z.object({
    type: z.literal('session.status'),
    conversationId: z.string(),
    status: Conversation.shape.status,
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('usage.updated'),
    conversationId: z.string(),
    usage: Usage,
  }),
  z.object({ type: z.literal('display.changed'), display: DisplayState }),
  z.object({
    type: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    message: z.string(),
  }),
])
export type CindlEvent = z.infer<typeof CindlEvent>
export type CindlEventType = CindlEvent['type']
export const cindlEventTypes = CindlEvent.options.map((o) => o.shape.type.value)
