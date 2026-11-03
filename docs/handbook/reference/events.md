# Events and errors

Clients learn what happened only through `CindlEvent`s
(`packages/contracts/src/events.ts`), delivered to `CindlClientApi.subscribe`.
The adapter normalizes Hermes wire notifications into these events, so
`message.delta` here is Cindl's event, not the Hermes notification of the same
name. `client-core` reduces each event into one state tree with a pure
reducer; UI code never writes to that state directly.

The Hermes-to-Cindl mapping belongs to the live transport, which is not built
yet (see the [acceptance matrix](../project/acceptance-matrix.md)). Today the
events come from the synthetic demo scenario and the `client-core` tests.

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
| [`requests.synced`](#requests-synced)             | `conversationId`: string; `openRequestIds`: string[]; `connectionEpoch`: optional number                                                                         |
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
last error. The reducer replaces the stored link state. Clients show it in the
presence line, and a `demo: true` link always shows the synthetic-data banner.

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

Hermes asked the owner something: a command approval or a clarifying
question, sent as a server-to-client JSON-RPC request. The reducer keys it by
Hermes's request id (`srq-…`), which stays the same when Hermes re-sends the
request after a reconnect. A re-sent frame updates the stored request and
never duplicates it. It never reopens a request that Hermes closed, cancelled
or expired, and it keeps an answer that is still being sent. If Hermes re-sends
a request this client answered, that answer did not land (Hermes keeps the
first reply), so the request becomes answerable again. Any attached client may
answer; the first reply wins.

### `request.closed`

Hermes closed a request: `answered`, `resolved-elsewhere` (another client
answered first, or Hermes resolved it without this client), `cancelled` or
`expired`. The reducer applies it only while the request is still open or
being answered here, and records `answered` whenever this client had sent an
answer.

### `requests.synced`

After a connection or replay, for one conversation: the ids of the requests
Hermes still holds open there. The reducer closes that conversation's other
requests that were still open or being answered here: `answered` if this
client had sent an answer, otherwise `resolved-elsewhere`. A decision made on
another device therefore does not stay answerable here.

### `request.answer-failed`

This client's answer could not be sent. The reducer returns a request that was
being answered to `open` and drops the unsent answer, so the owner can answer
it again.

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

| Code              | Meaning                                                                                                                                    | What the owner can do                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `unauthenticated` | This device is not signed in to Hermes, or Hermes rejected its session or tokens.                                                          | Sign in again on this device.                                                 |
| `forbidden`       | Hermes refused the request for this sign-in, or rejected the client's origin.                                                              | Check that the client reaches the intended Hermes origin.                     |
| `unsupported`     | This Hermes version or transport does not offer the operation; its capability is `unsupported`.                                            | Nothing on this device. It needs a Hermes change.                             |
| `unavailable`     | Hermes supports the operation, but not right now; for example the agent's screen is stopped.                                               | Try again once the stated reason no longer applies.                           |
| `conflict`        | The target changed since it was read (a SOUL.md or skill version mismatch), or the request was already answered or closed.                 | Reload, review the new version or request, then decide again.                 |
| `invalid`         | The arguments failed validation, or the answer was not a choice Hermes offered.                                                            | Correct the input. If it repeats, report it; it points to a client bug.       |
| `not-found`       | The conversation, routine, skill or request no longer exists.                                                                              | Refresh. It was removed or finished elsewhere.                                |
| `timeout`         | Hermes did not answer in time.                                                                                                             | Check the current state before you retry a change.                            |
| `offline`         | There is no connection to Hermes, so nothing was sent.                                                                                     | Reconnect, then try again.                                                    |
| `uncertain`       | The request may or may not have reached Hermes, for example when a connection dropped during a send. Cindl never retries it automatically. | Check the conversation, then resend or discard the prompt.                    |
| `protocol`        | Hermes sent something Cindl does not understand, such as an unexpected frame or field.                                                     | Report it with the redacted details. Check that Hermes is the pinned version. |
| `internal`        | An unexpected error inside Cindl.                                                                                                          | Report it with the redacted details.                                          |
