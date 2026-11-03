# Client operations

`CindlClientApi` is the only surface UI code calls
(`packages/contracts/src/ops.ts`). Every operation validates its arguments
with Zod; on Electron the main process validates them again before anything
reaches Hermes. There is no generic RPC or REST passthrough.

| Operation                | Requires capability    | Changes state | Summary                                                                                     |
| ------------------------ | ---------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `link.get`               | none                   | no            | Current connection state.                                                                   |
| `capabilities.get`       | none                   | no            | Negotiated capabilities for this connection.                                                |
| `auth.signIn`            | none                   | yes           | Sign in to a hermes serve origin with the platform flow (native PKCE or same-origin login). |
| `auth.signOut`           | none                   | yes           | Forget this device’s tokens. Hermes v0.22.5 cannot revoke issued native tokens remotely.    |
| `conversations.list`     | `sessions.list`        | no            | Hermes sessions for the active profile.                                                     |
| `conversations.create`   | `sessions.create`      | yes           | Start a side conversation.                                                                  |
| `conversations.setMain`  | none                   | no            | Pin the device’s main conversation (stored on this device).                                 |
| `conversations.rename`   | `sessions.rename`      | yes           | Rename a conversation in Hermes.                                                            |
| `conversations.history`  | `sessions.history`     | no            | Stored transcript for a conversation.                                                       |
| `prompt.submit`          | `chat.stream`          | yes           | Send a message. Never retried automatically once its outcome is uncertain.                  |
| `prompt.discard`         | none                   | no            | Drop a queued or uncertain local prompt without sending it.                                 |
| `conversation.interrupt` | `chat.interrupt`       | yes           | Ask Hermes to stop the current turn.                                                        |
| `request.answer`         | none                   | yes           | Answer one open server request, once, with an offered choice.                               |
| `routines.list`          | `routines.read`        | no            | Scheduled Hermes cron jobs.                                                                 |
| `routines.setEnabled`    | `routines.write`       | yes           | Pause or resume a cron job.                                                                 |
| `skills.list`            | `skills.read`          | no            | Installed skills.                                                                           |
| `skills.read`            | `skills.read`          | no            | A skill’s SKILL.md content.                                                                 |
| `skills.write`           | `skills.write`         | yes           | Replace a skill’s content after a reviewed diff; rejected if it changed since read.         |
| `soul.read`              | `soul.read`            | no            | The profile’s SOUL.md.                                                                      |
| `soul.write`             | `soul.write`           | yes           | Replace SOUL.md after a reviewed diff; rejected if it changed since read.                   |
| `memory.overview`        | `memory.overview`      | no            | Memory metadata. Memory text is not exposed by Hermes v0.22.5.                              |
| `connections.mcp`        | `connections.mcp`      | no            | Cached MCP server health (read-only; does not probe).                                       |
| `connections.accounts`   | `connections.accounts` | no            | Account coverage evidence, when a safe source exists.                                       |
| `display.status`         | `computer.view`        | no            | State of the agent-owned screen. Never starts it.                                           |
| `display.acquireControl` | `computer.control`     | yes           | Take the input lease for the agent-owned screen.                                            |
| `display.releaseControl` | `computer.control`     | yes           | Return the input lease.                                                                     |

Rules every implementation follows:

- Owner edits (`skills.write`, `soul.write`, `routines.setEnabled`,
  `display.acquireControl`) require `confirm: true`; document writes also
  require the `expectedVersion` that was read.
- `request.answer` takes the JSON-RPC id and connection epoch of the request
  and one of the choices Hermes offered (`once` or `deny` for approvals).
- Operations that change what a client knows also emit the corresponding
  events (for example `conversations.history` emits `history.loaded`).
- Errors are `CindlError` with a stable code: `unauthenticated`, `forbidden`, `unsupported`, `unavailable`, `conflict`, `invalid`, `not-found`, `timeout`, `offline`, `uncertain`, `protocol`, `internal`.
