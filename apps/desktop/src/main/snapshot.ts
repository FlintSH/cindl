import type { ClientState } from '@cindl/client-core'
import type { CindlEvent } from '@cindl/contracts'

/**
 * Events that rebuild `state` in a fresh client-core store. Main keeps a
 * mirror of everything its client emitted; when a renderer (re)subscribes,
 * for example after a reload, it receives this snapshot first and then live
 * events, so it never depends on having seen the stream from the start.
 *
 * Order matters: tool activity goes before history, because the reducer
 * anchors a newly seen tool into the streaming assistant message, and the
 * mirrored messages already contain those anchors. Notices are transient and
 * are not replayed.
 */
export function snapshotEvents(state: ClientState): CindlEvent[] {
  const events: CindlEvent[] = [
    { type: 'link.changed', link: state.link },
    { type: 'capabilities.changed', capabilities: state.capabilities },
  ]
  for (const conversation of Object.values(state.conversations))
    events.push({ type: 'conversation.upserted', conversation })
  for (const activity of Object.values(state.tools))
    events.push({ type: 'tool.updated', activity })
  for (const [conversationId, messages] of Object.entries(state.messages))
    events.push({ type: 'history.loaded', conversationId, messages: [...messages] })
  for (const prompt of Object.values(state.prompts))
    events.push({ type: 'prompt.updated', prompt })
  for (const request of Object.values(state.requests))
    events.push({ type: 'request.opened', request })
  for (const [conversationId, usage] of Object.entries(state.usage))
    events.push({ type: 'usage.updated', conversationId, usage })
  if (state.display) events.push({ type: 'display.changed', display: state.display })
  return events
}
