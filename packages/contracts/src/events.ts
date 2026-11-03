import { z } from 'zod'
import { CapabilityMap } from './capabilities.ts'
import {
  Conversation,
  DisplayState,
  Message,
  PendingPrompt,
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
  z.object({ type: z.literal('request.opened'), request: ServerRequest }),
  z.object({
    type: z.literal('request.closed'),
    rpcId: z.union([z.string(), z.number()]),
    status: z.enum(['answered', 'cancelled', 'expired', 'failed']),
  }),
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
