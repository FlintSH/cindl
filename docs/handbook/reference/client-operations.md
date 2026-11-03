# Client operations

`CindlClientApi` is the only surface UI code calls
(`packages/contracts/src/ops.ts`). Every operation validates its arguments
with Zod; the desktop app's main process is designed to validate them again
before anything reaches Hermes (in progress). There is no generic RPC or REST
passthrough.

The table is generated from `clientOps`, so it always matches the contract.
To change it, change `packages/contracts/src/ops.ts` through the
[contract-change protocol](../development/workflow.md#contract-changes), then
run `node scripts/generate-docs-reference.mjs`. The docs coverage gate fails
when the table and the contract differ.

<!-- BEGIN GENERATED: client-operations. Source: packages/contracts/src/ops.ts. Regenerate with node scripts/generate-docs-reference.mjs -->

| Operation                | Requires capability    | Changes state | Summary                                                                                                                            |
| ------------------------ | ---------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `link.get`               | none                   | no            | Current connection state.                                                                                                          |
| `capabilities.get`       | none                   | no            | Negotiated capabilities for this connection.                                                                                       |
| `auth.signIn`            | none                   | yes           | Sign in to a hermes serve origin with the platform flow (native PKCE or same-origin login).                                        |
| `auth.signOut`           | none                   | yes           | Forget this device’s tokens. Hermes v0.22.5 cannot revoke issued native tokens remotely.                                           |
| `conversations.list`     | `sessions.list`        | no            | Hermes sessions for the active profile.                                                                                            |
| `conversations.create`   | `sessions.create`      | yes           | Start a side conversation.                                                                                                         |
| `conversations.setMain`  | none                   | no            | Pin the device’s main conversation (stored on this device).                                                                        |
| `conversations.rename`   | `sessions.rename`      | yes           | Rename a conversation in Hermes.                                                                                                   |
| `conversations.history`  | `sessions.history`     | no            | Stored transcript for a conversation.                                                                                              |
| `prompt.submit`          | `chat.stream`          | yes           | Send a message. Never retried automatically once its outcome is uncertain.                                                         |
| `prompt.discard`         | none                   | no            | Drop a queued or uncertain local prompt without sending it.                                                                        |
| `conversation.interrupt` | `chat.interrupt`       | yes           | Ask Hermes to stop the current turn.                                                                                               |
| `request.answer`         | none                   | yes           | Answer one open approval or clarify request once (never an unsupported one); clarify sets are answered in one submission.          |
| `routines.list`          | `routines.read`        | no            | Scheduled Hermes cron jobs.                                                                                                        |
| `routines.setEnabled`    | `routines.write`       | yes           | Pause or resume a cron job.                                                                                                        |
| `skills.list`            | `skills.read`          | no            | Installed skills.                                                                                                                  |
| `skills.read`            | `skills.read`          | no            | A skill’s SKILL.md content.                                                                                                        |
| `skills.write`           | `skills.write`         | yes           | Replace a skill’s content after a reviewed diff; rejected if it changed since read.                                                |
| `soul.read`              | `soul.read`            | no            | The profile’s SOUL.md.                                                                                                             |
| `soul.write`             | `soul.write`           | yes           | Replace SOUL.md after a reviewed diff; rejected if it changed since read.                                                          |
| `memory.overview`        | `memory.overview`      | no            | Memory provider metadata (GET /api/memory). Entries are a separate capability.                                                     |
| `memory.entries`         | `memory.text`          | no            | Memory entries (agent notes and the user profile) as Hermes lists them.                                                            |
| `memory.read`            | `memory.text`          | no            | One memory entry in full.                                                                                                          |
| `memory.write`           | `memory.text`          | yes           | Replace one entry after a reviewed diff; refused if it changed since it was read (its id is its version).                          |
| `memory.delete`          | `memory.text`          | yes           | Delete one entry. Permanent: Hermes keeps no backup.                                                                               |
| `connections.mcp`        | `connections.mcp`      | no            | Cached MCP server health (read-only; does not probe).                                                                              |
| `connections.accounts`   | `connections.accounts` | no            | Account coverage evidence, when a safe source exists.                                                                              |
| `display.status`         | `computer.view`        | no            | State of the agent-owned screen. Never starts it.                                                                                  |
| `display.acquireControl` | `computer.control`     | yes           | Take the input lease for the agent-owned screen.                                                                                   |
| `display.releaseControl` | `computer.control`     | yes           | Return the input lease.                                                                                                            |
| `display.watch`          | `computer.view`        | no            | Start showing the agent-owned screen. Never starts the screen.                                                                     |
| `display.frame`          | `computer.view`        | no            | What changed on the screen since the last call; waits a few seconds for a change.                                                  |
| `display.unwatch`        | none                   | yes           | Stop showing the screen. While online, a lease this device holds returns to the agent; with the link down it stays with the owner. |
| `display.input`          | `computer.control`     | yes           | Pointer and key input, sent only while this device holds control. Never logged.                                                    |

<!-- END GENERATED: client-operations -->

"Requires capability" is the capability that must be `available` or `limited`
before a client attempts the operation; see [Capabilities](capabilities.md).
"Changes state" means the operation changes something on the Hermes host or
this device's sign-in.

Rules every implementation follows:

- Owner edits (`skills.write`, `soul.write`, `memory.write`, `memory.delete`,
  `routines.setEnabled`, `display.acquireControl`) require `confirm: true`;
  document writes also require the `expectedVersion` that was read.
- Memory entries are addressed only by their current fingerprinted id
  (`memory:<store>:<index>:<fingerprint>`): it is also the entry's version, so
  Hermes refuses a write or delete once the entry changed. Positional ids are
  refused. Hermes keeps no backup, so a delete is permanent. The index counts
  across both stores, agent notes first (`agent/learning_graph.py`), so it is
  not an entry's place in its store; clients name the id they read, never one
  they compute.
- `request.answer` takes the Hermes request id (`srq-…`) and either one offered
  approval choice (`once` or `deny`), one submission covering every open
  question of a clarify set (each answered or skipped; questions another client
  locked are left out). There is no decline: an empty reply would reach the
  agent like an interrupt, so dismissing a set means skipping every question.
  `unsupported` requests (sudo,
  secret, vault and unknown prompts) are rejected with `unsupported` and Cindl
  sends Hermes nothing for them. The request lifecycle is in
  [server requests](server-requests.md).
- Sign-in origins must be https (plain http only on 127.0.0.1 or [::1]) with no
  credentials, path, query or fragment. Profile names and ids use narrow
  character sets; skill names may be `name` or `category/name` and may contain
  spaces, but not control characters, `\`, `?`, `#`, `%` or `..`.
- Operations that change what a client knows also emit the corresponding
  [events](events.md) (for example `conversations.history` emits
  `history.loaded`).
- Arguments that fail validation are rejected before anything is sent:
  `CindlError` `invalid`, with a message that starts `Not sent:`.
- Errors are `CindlError` with a stable code. Every code, what it means and
  what the owner can do is listed under [Error codes](events.md#error-codes).
