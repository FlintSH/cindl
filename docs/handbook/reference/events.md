# Events and errors

Clients learn what happened only through `CindlEvent`s
(`packages/contracts/src/events.ts`), delivered to `CindlClientApi.subscribe`.
The adapter normalizes Hermes wire notifications into these events, so
`message.delta` here is Cindl's event, not the Hermes notification of the same
name. `client-core` reduces each event into one state tree with a pure
reducer; UI code never writes to that state directly.

The direct client tells a subscriber that joins after its first link what it
already knows, as the events that build it: the link, the capabilities, its
conversations, pending prompts, open requests and the screen. A renderer
remounted with a new store, after an error boundary, so never waits on a link
that has already settled. A subscriber that joins before the first link hears
only what comes next.

The direct client (`packages/client-core/src/direct`) maps what Hermes sends
and answers onto these events in every real build: the web served from its
Hermes's origin, the desktop app's main process and the Android app. The
mapping is in [Hermes v0.22.5](hermes-v0.22.5.md). The synthetic demo scenario
emits the same events. What each client has been run against is in the
[acceptance matrix](../project/acceptance-matrix.md).

## Event summary

Generated from the `CindlEvent` schema. Named types such as `Conversation` are
exported from `@cindl/contracts`; values in code style are the exact strings
on the wire.

<!-- BEGIN GENERATED: events. Source: packages/contracts/src/events.ts. Regenerate with node scripts/generate-docs-reference.mjs -->

| Event                                             | Payload                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`link.changed`](#link-changed)                   | `link`: LinkState                                                                                                                                                |
| [`capabilities.changed`](#capabilities-changed)   | `capabilities`: CapabilityMap                                                                                                                                    |
| [`conversation.upserted`](#conversation-upserted) | `conversation`: Conversation                                                                                                                                     |
| [`conversation.removed`](#conversation-removed)   | `conversationId`: string                                                                                                                                         |
| [`history.loaded`](#history-loaded)               | `conversationId`: string; `messages`: Message[]                                                                                                                  |
| [`history.reset`](#history-reset)                 | `conversationId`: string; `reason`: `epoch-changed` / `truncated` / `resync`                                                                                     |
| [`message.started`](#message-started)             | `conversationId`: string; `messageId`: string; `role`: `user` / `assistant` / `system`                                                                           |
| [`message.delta`](#message-delta)                 | `conversationId`: string; `messageId`: string; `kind`: `text` / `reasoning`; `text`: string                                                                      |
| [`message.completed`](#message-completed)         | `conversationId`: string; `messageId`: string; `status`: `complete` / `interrupted` / `error`; `text`: optional string                                           |
| [`tool.updated`](#tool-updated)                   | `activity`: ToolActivity                                                                                                                                         |
| [`prompt.updated`](#prompt-updated)               | `prompt`: PendingPrompt                                                                                                                                          |
| [`request.opened`](#request-opened)               | `request`: ServerRequest                                                                                                                                         |
| [`request.closed`](#request-closed)               | `requestId`: string; `status`: `answered` / `resolved-elsewhere` / `cancelled` / `expired`; `answer`: optional RequestAnswer; `connectionEpoch`: optional number |
| [`requests.synced`](#requests-synced)             | `conversationId`: optional string; `openRequestIds`: string[]; `connectionEpoch`: optional number                                                                |
| [`request.answer-failed`](#request-answer-failed) | `requestId`: string; `connectionEpoch`: optional number                                                                                                          |
| [`prompt.removed`](#prompt-removed)               | `clientId`: string                                                                                                                                               |
| [`session.status`](#session-status)               | `conversationId`: string; `status`: `idle` / `working` / `waiting-on-you` / `unknown`; `detail`: optional string                                                 |
| [`usage.updated`](#usage-updated)                 | `conversationId`: string; `usage`: Usage                                                                                                                         |
| [`display.changed`](#display-changed)             | `display`: DisplayState                                                                                                                                          |
| [`notice`](#notice)                               | `level`: `info` / `warning` / `error`; `message`: string                                                                                                         |

<!-- END GENERATED: events -->

## Events

### `link.changed`

The connection to Hermes changed phase (for example `connecting`, `online`,
`reconnecting`, `offline`, `signed-out` or `incompatible`) or its details
changed: server identity, sign-in method, connection epoch, replay epoch or the
last error. The reducer replaces the stored link state. When the link names a
different Hermes origin than the state's data came from, the reducer also
forgets everything that came from the previous one (conversations, messages,
tools, prompts, requests, usage, the screen and capabilities) and keeps only
this device's notices; a link that names no server, or the same one, changes
nothing else. Clients show it in the presence line, and a `demo: true` link
always shows the synthetic-data banner.

Before it connects, the direct client asks Hermes what it is
(`GET /api/status`) and whether this device is signed in. When Hermes does not
answer either (no network, a timeout, a 5xx while it restarts, rate limiting),
the link is `offline` with that error, and the client asks again with the
reconnect backoff, keeping that link until an attempt succeeds. Only the
adapter's own reports of that (`hermesDidNotAnswer`) count, never a code
alone. An answer that is not Hermes is `error` and is not repeated, and so is
a failure on this device, such as a secret store that cannot be read: asking
Hermes again cannot fix it, so the next `start()` or sign-in tries again. A
discovery or sign-in that
`stop()`, a newer `start()` or another sign-in overtakes neither connects nor
changes the link.

### `capabilities.changed`

The negotiated capabilities for this connection changed. The reducer replaces
the whole map. A capability missing from the map is `unknown` and is never
rendered as working; see [Capabilities](capabilities.md).

### `conversation.upserted`

A conversation (one Hermes session) was created, renamed or otherwise
changed. The reducer inserts it, or replaces the stored copy with the same id.

### `conversation.removed`

A conversation no longer exists for this client. The reducer drops the
conversation and any messages loaded for it.

### `history.loaded`

The stored transcript of a conversation. Implementations emit it with the
result of the `conversations.history` operation. The reducer replaces the
conversation's loaded messages with these.

### `history.reset`

Loaded messages for a conversation can no longer be trusted: the Hermes replay
epoch changed (`epoch-changed`), the replay window was truncated (`truncated`)
or a full resync was requested (`resync`). The reducer drops the messages, and
the client reloads history instead of trusting a partial replay.

### `message.started`

A user, assistant or system message began. The reducer adds an empty message
with status `streaming`, unless a message with that id is already loaded.

### `message.delta`

A piece of streamed text or reasoning for a message. The reducer appends it to
the message's last part of the same kind. If the start was missed, it creates
an assistant message first so no text is lost.

### `message.completed`

A message finished as `complete`, `interrupted` or `error`. When Hermes sent
authoritative final text, it replaces the streamed text parts; reasoning and
tool parts are kept.

### `tool.updated`

A tool step was created or changed: status, progress, duration, redacted
argument and result previews, or an output-risk warning. A new tool is anchored
in the conversation's latest streaming assistant message so steps render in
the order they ran.

### `prompt.updated`

A prompt this device submitted changed state: `queued-offline`, `sending`,
`accepted`, `uncertain` or `failed`, with Hermes's disposition once accepted.
Prompts are keyed by their client id. An `uncertain` prompt is never resent
automatically; the owner decides.

### `prompt.removed`

A local prompt record (queued or uncertain) was dismissed by the owner or
delivered. The reducer drops the record for that client id.

### `request.opened`

Hermes holds a request open: a command approval, a clarify set, or a prompt
Cindl never answers (`unsupported`, with an `unsupportedKind` of `sudo`,
`secret`, `vault` or `other`). Approvals and clarify sets belong to a
conversation; an unsupported prompt may be app-wide. The event comes from a
live request frame or from Hermes's open-requests list after a reconnect,
never from history replay. A re-send on a newer connection reopens the
request, and a frame from an older one changes nothing. The whole lifecycle is
on [Server requests](server-requests.md#events).

### `request.closed`

The request is no longer open, with Hermes's status. `answered` means Hermes
acknowledged this client's answer, not that the resulting action succeeded,
and the event carries the `answer` Hermes accepted. The other statuses are
`resolved-elsewhere` (closed without an acknowledged answer from this
client), `cancelled` and `expired`. A closed request keeps the answer this
client sent. When the close is the outcome of this client's
attempt, it carries that attempt's `connectionEpoch`. See
[Statuses](server-requests.md#statuses).

### `requests.synced`

One event per conversation with open requests, after a reconnect, listing what
Hermes still holds open there, and one without `conversationId` listing the
app-level requests (those with no conversation) Hermes holds. That scope's
other open or answering requests close as `resolved-elsewhere`, because Hermes
cannot say whose answer it used; other scopes are untouched. A changed
connection alone never closes an app-level request: Hermes cancels none on a
disconnect. A list from an older connection cannot
close a request seen on a newer one. See
[Server requests](server-requests.md#events).

### `request.answer-failed`

This client's answer did not reach Hermes, or Hermes rejected it and still
holds the request open, so the request is answerable again. With a
`connectionEpoch` it applies only to the attempt sent on that connection: a
late failure of an older attempt cannot unlock a newer one. See
[Server requests](server-requests.md#events).

### `session.status`

The live status of a conversation changed: `idle`, `working`,
`waiting-on-you` or `unknown`, with optional detail. The reducer updates a
known conversation's status; the detail is not stored.

### `usage.updated`

Token and cost figures Hermes reported for a conversation. The reducer replaces
the stored usage for that conversation. Cindl shows only what Hermes reports
and never estimates missing values.

### `display.changed`

The state of the agent-owned screen changed: whether it runs, who controls
input, and whether this device holds the input lease. The reducer replaces the
stored display state. Viewing never starts a screen.

### `notice`

A message for the owner that belongs to no conversation, at level `info`,
`warning` or `error`. The reducer keeps the 20 most recent notices.

## Error codes

Operations reject with `CindlError` (`packages/contracts/src/errors.ts`). The
code is stable across clients and versions; the message is written for the
owner and the optional detail is redacted diagnostics only. This table is the
user-facing meaning of each code.

| Code              | Meaning                                                                                                                                                                           | What the owner can do                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `unauthenticated` | This device is not signed in to Hermes, or Hermes rejected its session or tokens.                                                                                                 | Sign in again on this device.                                                 |
| `forbidden`       | Hermes refused the request for this sign-in, or rejected the client's origin.                                                                                                     | Check that the client reaches the intended Hermes origin.                     |
| `unsupported`     | This Hermes version or transport does not offer the operation (its capability is `unsupported`), or the request is a prompt Cindl never answers, such as a sudo or secret prompt. | Nothing on this device. Answer such a prompt in another Hermes surface.       |
| `unavailable`     | Hermes supports the operation, but not right now; for example the agent's screen is stopped.                                                                                      | Try again once the stated reason no longer applies.                           |
| `conflict`        | The target changed since it was read (a SOUL.md or skill version mismatch), or the request was already answered or closed.                                                        | Reload, review the new version or request, then decide again.                 |
| `invalid`         | The arguments failed validation, or the answer was not a choice Hermes offered. Nothing was sent; the message starts `Not sent:`.                                                 | Correct the input. If it repeats, report it; it points to a client bug.       |
| `not-found`       | The conversation, routine, skill or request no longer exists.                                                                                                                     | Refresh. It was removed or finished elsewhere.                                |
| `timeout`         | Hermes did not answer in time.                                                                                                                                                    | Check the current state before you retry a change.                            |
| `offline`         | There is no connection to Hermes, so nothing was sent.                                                                                                                            | Reconnect, then try again.                                                    |
| `uncertain`       | The request may or may not have reached Hermes, for example when a connection dropped during a send. Cindl never retries it automatically.                                        | Check the conversation, then resend or discard the prompt.                    |
| `protocol`        | Hermes sent something Cindl does not understand, such as an unexpected frame or field.                                                                                            | Report it with the redacted details. Check that Hermes is the pinned version. |
| `internal`        | An unexpected error inside Cindl.                                                                                                                                                 | Report it with the redacted details.                                          |
