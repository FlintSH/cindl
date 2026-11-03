# Hermes v0.22.5 transport

Cindl's verified baseline is Hermes **v0.22.5**, commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`, desktop backend contract **8**.
Everything below was read from the public source at that commit; `file:line`
references are to that tree. None of it has been exercised against a live,
authenticated instance yet. The fake Hermes server in
`packages/fixtures/src/fake-hermes` emulates this subset for tests and is
checked against the vendored contract, but it is a test double, not evidence
about a real deployment.

Machine-readable sources in this repository:

- `packages/hermes-adapter/src/upstream-surface.ts`: the allowlist of methods,
  server requests and notifications.
- `packages/hermes-adapter/src/compat.ts`: REST endpoints, subprotocols, close
  codes, default request windows.
- `packages/hermes-adapter/upstream/v0.22.5/contract-subset.json`: the vendored
  upstream schemas for exactly that surface. Its SHA-256 is pinned in
  `test/upstream.test.ts`; regenerate only with
  `node packages/hermes-adapter/scripts/extract-upstream.ts --source <checkout>`.

## Deployment modes

`hermes dashboard` and `hermes serve` run the same FastAPI app. Its auth mode
is fixed at bind time (`hermes_cli/web_server_boundary.py:106-148`):

| Mode     | When                                                            | Credentials                                                                                                | Cindl                                                                                                                                 |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Loopback | Bound to `127.0.0.1`/`::1`/`localhost`, no public `public_url`  | One per-process token, sent as a header or `?token=`; readable from `GET /` by any local caller            | **Refused.** `/api/status` reports `auth_required: false`; Cindl reports the link as incompatible and never reads or uses that token. |
| Gated    | Any non-loopback bind, or a non-loopback `dashboard.public_url` | A sign-in provider (password, Nous Portal OAuth, self-hosted OIDC) is mandatory; startup fails without one | Supported: cookie session (web) or RFC 8252 native tokens (desktop, Android).                                                         |

Hermes has no TLS options; HTTPS comes from the operator's reverse proxy or
tunnel (`dashboard.public_url`, `dashboard.trusted_proxies`). CORS is
hard-coded to `^https?://(localhost|127\.0\.0\.1)(:\d+)?$` without
credentials (`hermes_cli/web_server.py:549-562`), so a browser client must be
served from the `hermes serve` origin itself; native clients do HTTP outside
the browser.

## REST

| Endpoint                                   | Auth    | Shape Cindl reads                                                          | Source                                     |
| ------------------------------------------ | ------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `GET /api/status`                          | public  | `version`, `auth_required`, `auth_flows`, `auth_providers`                 | `web_routers/status.py:383-405, 482-583`   |
| `GET /api/auth/providers`                  | public  | `providers[{name, display_name, supports_password}]`                       | `dashboard_auth/routes.py:203-213`         |
| `GET /api/auth/me`                         | session | `{user_id, provider, display_name, expires_at}` (e-mail dropped)           | `routes.py:524-553`                        |
| `POST /api/auth/ws-ticket`                 | session | `{ticket, ttl_seconds: 30}`, single use                                    | `routes.py:556-564`, `ws_tickets.py:20-64` |
| `GET /auth/native/authorize`               | public  | 302 to the loopback redirect with `code` and `state`                       | `routes.py:242-335`                        |
| `POST /auth/native/token`                  | public  | `{access_token, refresh_token, token_type, expires_at, provider, user_id}` | `routes.py:111-117, 574-591`               |
| `POST /auth/native/refresh`                | public  | same token set, rotated                                                    | `routes.py:594-617`                        |
| `GET /api/sessions/{id}/mutation-snapshot` | session | `{session_id, exists, runtime_revision, runtime_generation}`               | `web_routers/sessions.py:586-598`          |
| `PATCH /api/sessions/{id}`                 | session | fenced metadata write, see [Sessions](#sessions)                           | `sessions.py:926-934`                      |
| `GET /api/skills`                          | session | `[{name, description, category, enabled, provenance}]`                     | `web_routers/skills.py:343-376`            |
| `GET /api/skills/content?name=`            | session | `{name, content}` (the host `path` is dropped)                             | `skills.py:397-415`                        |
| `PUT /api/skills/content`                  | session | `{name, content, profile?}`, full rewrite                                  | `skills.py:433-444`                        |
| `GET /api/profiles/{name}/soul`            | session | `{content, exists}`                                                        | `web_routers/profiles.py:1000-1012`        |
| `PUT /api/profiles/{name}/soul`            | session | `{content}`, atomic full rewrite                                           | `profiles.py:1015-1034`                    |
| `GET /api/memory`                          | session | `{active, providers[], builtin_files{memory, user}}`, sizes only           | `web_routers/ops.py:494-509`               |

Session endpoints accept the cookie session or `Authorization: Bearer
<access token>` from the native flow, verified by the same provider stack
(`dashboard_auth/middleware.py:160-184`). That includes the ws-ticket route,
which only needs `request.state.session`. A missing or rejected credential on
`/api/*` answers `401 {error: "unauthenticated" | "session_expired", detail,
reason, login_url}` (`middleware.py:72-87`); an unreachable provider answers 503. Hermes has no CSRF tokens: browser sessions rely on `SameSite=Lax`
cookies, native clients on bearer tokens (`dashboard_auth/cookies.py:1-63`).
Cindl sends cookies only with `credentials: 'same-origin'` and never sends the
bearer to public endpoints.

### Native sign-in (desktop, Android)

- `GET /auth/native/authorize?code_challenge=<S256>&code_challenge_method=S256&redirect_uri=<loopback>&state=<s>[&provider=]`.
  The redirect must be `http://127.0.0.1[:port]/…` or `http://[::1][:port]/…`
  with a canonical authority, no userinfo, fragment, backslash or control
  characters; `localhost` is refused (`routes.py:242-276`). Cindl's
  `canonicalLoopbackRedirect` mirrors this and is stricter (lowercase scheme,
  port 1-65535).
- The pending authorization lives 600 s, the one-time code 120 s; at most 8
  pending per client IP and 256 overall (`native_flow.py:28-33`).
- `POST /auth/native/token {code, code_verifier}`: the code is removed before
  the PKCE check, so a wrong verifier burns it; every failure is a generic 400
  (`native_flow.py:140-152`, `routes.py:574-591`).
- `POST /auth/native/refresh {refresh_token, provider?}`: 401
  `{error: "session_expired"}` when every provider rejects the token, 503 when
  one is unreachable (`routes.py:594-617`). Cindl rotates once per expiry,
  shares one refresh between concurrent requests, forgets tokens on 401 and
  keeps them on 503.
- Tokens live in the OS-backed store only (Electron `safeStorage`, Android
  Keystore). Without one, Cindl keeps them in memory and says so. Sign-out is
  local: logout does not revoke native tokens, which are stateless (basic
  provider defaults: 12 h access, 30 d refresh).

## WebSocket `/api/ws`

### Connecting

1. `POST /api/auth/ws-ticket` mints a 30-second, single-use ticket. Cindl mints
   a new one for every connect and reconnect.
2. Open `wss://<origin>/api/ws` with subprotocols `hermes-gateway-v1` and
   `hermes-gateway-ticket.<ticket>` (`web_server_boundary.py:151-166`,
   `web_server_chat.py:265-283`). Exactly one ticket subprotocol is accepted;
   the server selects only `hermes-gateway-v1`. Hermes also accepts `?ticket=`
   and `?token=<access token>`; Cindl uses neither, so credentials never
   appear in URLs.
3. Hermes checks the credential, then Host and Origin, all before accepting
   the upgrade (`web_routers/chat_ws.py:161-173`). An absent Origin, or a
   non-http(s) one such as `app://`, is trusted; an http(s) Origin must name
   the bound host or the `public_url` host (`web_server_boundary.py:192-218`).
   A refusal at this stage is a close before accept, which uvicorn delivers as
   an opaque **HTTP 403**: a bad, used or expired ticket and a refused Origin
   look the same to the client (the display route documents this,
   `web_routers/display.py:73-81`). Cindl retries with a fresh ticket and
   backoff and, after repeated refusals, names Host/Origin as the likely cause.

### Handshake

- The first frame is `{method: "event", params: {type: "gateway.ready",
payload: {skin, change_events, heartbeat, replay_epoch,
session_authority?}}}` (`tui_gateway/ws.py:548-554`).
- Cindl immediately sends `client.capabilities {server_requests: true}`.
  Without it Hermes never sends server requests to that client and withdraws
  approvals at once (`tui_gateway/server_requests.py:30-34, 156-161`;
  `server.py:849-859`). The result lists every server-request method of the
  build and `declines_not_shown: true` (`methods_voice.py:521-538`).
- `session_authority: true` appears only when a session authority is attached,
  which `hermes serve` does not do; the gateway's own listener does
  (`ws.py:357-365`). Cindl then negotiates `runtime.describe` and uses only
  canonical method names on that socket, but it does not implement canonical
  sessions yet, so chat features report `unsupported` there. On the sidecar it
  probes `gateway.capabilities` (`{per_session_exclusive_submit}`).

### Framing and liveness

- One JSON-RPC 2.0 object per text frame both ways. Client ids are integers;
  Hermes's server-request ids are `srq-<12 hex>` strings, so they never
  collide (`server_requests.py:9-13`).
- Requests run serially per connection in arrival order; answers to server
  requests skip the queue (`ws.py:94-117`).
- Unknown params keys answer JSON-RPC error **4000** ("out of sync");
  unknown methods **-32601** (`tui_gateway/contracts/registry.py:89-118`,
  `ws.py:368-385`). Cindl treats either for a method on its allowlist as a
  version mismatch and marks the link `incompatible`.
- Heartbeat: Cindl sends `ping` (on the contract, `{pong: true}`) every 15 s
  and treats 45 s without any inbound frame as a dead socket. Hermes also
  answers a transport-level `gateway.ping` on the reader; it is outside the
  generated contract, so Cindl does not use it.

### Methods Cindl calls (legacy sidecar, contract 8)

`client.capabilities`, `gateway.capabilities`, `ping`, `session.create`,
`session.list`, `session.resume`, `session.title`, `session.events.since`,
`session.interrupt`, `prompt.submit`, `cron.manage`, `mcp.servers.status`,
`display.status`, `display.observe`, `display.lease.acquire`,
`display.lease.release`. The allowlist in `upstream-surface.ts` also names
methods Cindl may use later (`session.history`, `session.steer`,
`approval.respond`, `request.answer`, `process.list`, ...). Anything off the
allowlist, including every `connectors.*` call, is refused before it reaches
the wire.

## Sessions

- A stored session id (`YYYYMMDD_HHMMSS_<6 hex>`) is durable; a runtime id
  (8 hex) names a live agent in one process (`hermes_state_ids.py:1-6`,
  `methods_session.py:67`). Events carry runtime ids; REST takes stored ids.
- `session.create {title?, close_on_disconnect: false, idempotency_key?}`
  returns both ids. The stored row appears with the first prompt.
  `close_on_disconnect` defaults to false; detached sessions are reaped after
  `dashboard.ws_orphan_reap_grace_s` (20 s) unless a client re-attaches
  (`config_defaults.py:1036-1041`).
- `session.resume {session_id: <stored id>}` re-attaches a live session to the
  calling socket, alongside other clients, or builds a new runtime session
  (`methods_session.py:868-891, 1049-1082`). It returns the transcript, live
  status and `open_requests`.
- Renames use the fenced REST write: read
  `GET /api/sessions/{id}/mutation-snapshot`, then `PATCH /api/sessions/{id}
{request_id, expected_revision, expected_generation?, title}`. A changed
  revision answers 409 `revision_conflict`; a repeated `request_id` with the
  same payload replays the stored receipt, so a retry is safe
  (`web_server_sessions.py:253-302`, `hermes_state_runtime.py:484-546`).
  Requests without the fencing fields answer 409.

### Prompts

`prompt.submit {session_id, text}` answers `{status: streaming | queued |
steered | redirected, user_row_id?}` (`contracts/prompt_voice.py:26-83`). It
has no client message id, so a submit whose answer was lost may have run.
Cindl marks such a prompt `uncertain` and never resends it automatically.

### Replay after reconnect

Every session event gets a per-runtime-session `seq` and enters a ring of 512
events or 4 MiB, for at most 64 sessions per process
(`tui_gateway/event_replay.py:23-36, 72-123`).
`session.events.since {session_id, last_seen}` answers `{events, latest_seq,
truncated, count, epoch, open_requests}` (`methods_session.py:2309-2323`).
The ring is in memory: `epoch` changes when the process restarts, and a reaped
session's ring is dropped and reported as truncated. Cindl re-attaches with
`session.resume`, replays events newer than its watermark, and reloads the
transcript when the epoch changed or the window was truncated.

## Server-to-client requests

Hermes sends a request to every client attached to the session that
advertised `server_requests`; the **first reply wins** and settles it for all.
An error reply counts as "no answer" and also settles it. A reply for an id
that is no longer open is dropped (`server_requests.py:1-35, 191-227,
281-317`). Unanswered requests are re-listed in `open_requests` with the same
id after a reconnect (`server_requests.py:365-369`, `server.py:797-810`).
Withdrawals arrive as `request.cancel {id, method, reason}`.

### Approval and clarify

| Request    | Params                                                                                                                                  | Result Cindl sends                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `approval` | `{session_id, request_id, command (redacted by Hermes), description, choices, allow_session, allow_permanent, smart_denied, tool_name}` | `{choice: "once" \| "deny"}`, never `all`, never `session`/`always` |
| `clarify`  | `{session_id, questions[{qid, question, choices?, multi_select}], answers?}`                                                            | `{answers: {qid: string \| null}}`; `{}` declines the whole set     |

- Choices default to `once` (+ `session`, `always` unless smart-denied or
  disallowed) + `deny` (`server.py:781-794`). Cindl offers only the
  intersection with `once`/`deny` and lists the rest as withheld.
- A multi-select answer is a JSON array string, which Hermes parses
  (`tools/clarify_tool.py:36-47`); `null` marks a skipped question.
- Approvals wait `approvals.timeout` (default 300 s,
  `tools/approval_context.py:305-313`); clarify waits `clarify.timeout`
  (default 3600 s, `tools/clarify_gateway.py:296-308`). Both fail closed and
  announce the end with `request.cancel`; interrupts also emit
  `approval.cancelled`. Cindl takes Hermes's announcement, or the request's
  absence from `open_requests` after a reconnect, as the end; it does not
  guess a local deadline because the windows are configurable.
- An error reply to an approval withdraws it rather than denying it
  (`server.py:849-862`).

How Cindl tracks them: each request is keyed by its `srq-` id, which stays the
same when Hermes re-lists it after a reconnect, and can be answered from any
connection. Before sending an answer, the device records it in a local ledger;
it never sends a second, different answer for the same id. If Hermes still
lists an answered request after a reconnect, the reply was lost in transit, and
Cindl re-sends the same recorded decision (the first reply wins, so this cannot
answer twice). After every reconnect Cindl emits `requests.synced` with the ids
Hermes still holds open; anything else it showed as open was resolved elsewhere
or timed out.

### Requests Cindl does not answer

A blanket error reply would close a request for the client that can answer
it, so Cindl's non-answer depends on the kind:

| Kind                                                                                                                                         | Cindl's reply                | Why                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview.act`, `preview.read`, `terminal.read`, `theme.apply`, `window.read`, `tour`                                                         | error **4404** ("not shown") | Window-owned bridges. Hermes counts 4404 as one client declining and settles only when every client declined (`server_requests.py:117-121, 254-278`); the desktop app does the same (`WINDOW_OWNED_REQUESTS`). Sent only when `declines_not_shown` is true.                                                                                                                             |
| `secret`, `sudo`, `vault.unlock_prompt`, `vault.save_login`, `vault.code`, `display.install.sudo`, `theme.pick`, `setup_beat`, unknown kinds | **no reply**                 | A unanimous decline settles with a "not shown" value that `_ask` hands back as the answer, which would be stored as a secret or tried as a password (`agent_callbacks.py:244-283`). An error reply would beat a client that can answer. Another client answers, or Hermes's own deadline fails the request closed. Cindl tells the user Hermes is waiting for input it does not handle. |

## Events

Handled notification types are listed in `upstream-surface.ts`; their payload
schemas are vendored. Cindl maps `message.*`, `reasoning.*`, `thinking.delta`
and `tool.*` into messages and tool activity (previews redacted and
truncated), `status.update`, `session.info`, `session.usage` and
`session.title` into conversation state, `subagent.*` into delegated activity,
`request.cancel` and `approval.cancelled` into closed requests, and
`display.*` into the screen state. `sessions.changed`, `cron.changed` and
`skills.changed` are change signals. `message.delta`, `reasoning.delta` and
`thinking.delta` are coalesced by Hermes on a 33 ms timer (`ws.py:118-123`).
Unknown types are ignored, never guessed.

## Skills and SOUL.md

Both are whole-file rewrites with no server-side compare-and-swap and no
backup. Skill names are looked up by name, never by path, with a 100,000
character limit (`tools/skill_manager_tool.py:41-63`). SOUL.md writes are
atomic (temp file and replace) and the profile name is validated and must
exist (`web_server_profiles.py:190-199`). Cindl re-reads and compares the
SHA-256 of the version the owner reviewed before writing, which narrows but
cannot close the race; both capabilities are `limited`.

## Memory

`GET /api/memory` reports sizes and providers only. Individual entries are a
separate surface (`web_routers/status.py:693-743`,
`agent/learning_graph.py`, `agent/learning_mutations.py`):

| Route                                 | Request                   | Answer                                                                                                            |
| ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/learning/graph?profile=`    | none                      | `memory: [{source: memory \| profile, timestamp, title, body (first 1200 chars), fingerprint}]` and a skill graph |
| `GET /api/learning/node?id=&profile=` | entry id                  | `{ok, kind: "memory", id, label, content}`; 404 with a message on failure                                         |
| `PUT /api/learning/node`              | `{id, content, profile?}` | `{ok, message}`; 400 with a message on failure                                                                    |
| `DELETE /api/learning/node`           | `{id, profile?}`          | `{ok, message}`; 400 with a message on failure                                                                    |

- An entry id is `memory:<source>:<index>:<fingerprint>`, where `source` is
  `memory` (MEMORY.md, agent notes) or `profile` (USER.md) and the fingerprint
  is `sha256(entry.strip())[:12]` (`learning_graph.py:143-158`). Hermes
  resolves the fingerprint under the memory store's file lock, re-reads, and
  refuses with "memory node id is stale" when no entry has that text any more
  (`learning_mutations.py:52-112`). The id is therefore a per-entry
  compare-and-swap version.
- Ids without a fingerprint resolve by position (`learning_mutations.py:63-77`);
  ids outside the `memory:` namespace address skills on the same routes
  (`learning_mutations.py:127-133, 182-207`). Cindl refuses both.
- A replacement may not push the file past its character limit: MEMORY.md
  2200, USER.md 1375 by default (`tools/memory_tool.py:47-60`,
  `learning_mutations.py:101-109`). Empty text is refused; delete instead.
- There is no undo. An edit or delete rewrites the file atomically and keeps
  no copy (`tools/memory_tool_store.py:338-367, 676-683`). A `.bak.<ts>`
  snapshot is written only when Hermes refuses to touch a file that drifted
  (an entry longer than the whole limit), and that refusal message contains a
  host path, which Cindl never shows (`memory_tool_store.py:49-60, 685-700`).
- The dashboard edit path does not run the memory tool's injection scan, and
  memory enters the system prompt as a snapshot at session start, so edits
  apply to new sessions (`tools/memory_tool.py:1-5`).
- Wrong profile: 400 for an invalid name, 404 for an unknown one
  (`web_server_profiles.py:190-199`).

Status in Cindl: adapter-level functions (`memory-entries.ts`) and tests exist;
no client operation exposes them until the `memory.text` contract change is
applied, so the capability stays `unsupported`. Cindl never reads memory
through `/api/fs/*` or any other filesystem route, and never uses
`POST /api/memory/reset`.

## Routines

`cron.manage {action: list | add | remove | pause | resume, name?,
include_disabled?}` (`tui_gateway/methods_tools.py:1308-1332`). `list` hides
paused jobs unless `include_disabled` is true; Cindl always asks for them.
`pause` and `resume` take the job id in `name` and return `{success, job}`.
Rows carry `job_id, name, schedule, enabled, state, next_run_at, last_run_at,
last_status` (`tools/cronjob_job_args.py:476-511`). Cron runs in the gateway
process; a dashboard without a gateway stores jobs that never fire.

## Connections

`mcp.servers.status` reports cached runtime state per configured MCP server
(`connected | disabled | connecting | failed | lazy | configured`) without
connecting, probing or starting auth (`contracts/tools_mcp_plugins.py:408-436`).
Cindl keeps the name, state and tool count only. `connectors.*` is not
account-coverage evidence and some calls create guest identities; Cindl never
calls it.

## Agent screen

- `display.status` is a read-only snapshot with the lease
  (`tui_gateway/methods_display.py:50-57`). Cindl never calls
  `display.start`, `display.stop` or `display.install`.
- `display.observe` mints a single-use 30 s ticket for `/api/display/ws`
  (`?display_ticket=`) and a viewer id bound to the calling connection
  (`methods_display.py:113-168`). The RFB stream itself is not exposed through
  Cindl's operations yet.
- `display.lease.acquire {viewer_id}` and `display.lease.release {viewer_id}`
  accept only viewer ids minted on the same connection
  (`methods_display.py:234-262`). The lease shows the holder only as
  `viewer_hash = sha256(viewer_id)[:12]` (`tools/bot_desktop/lease.py:67`),
  which is how Cindl recognises its own lease. After a reconnect the old
  viewer id belongs to a closed connection and cannot release the lease.
- Display close codes: 4000 evicted controller, 4001 screen stopped, 4401
  ticket missing, expired or used (after accept), 4403 Host/Origin refused,
  1003 non-binary frame (`web_routers/display.py:37-42`).

## Not used at v0.22.5

| Surface                                    | Why                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Loopback per-process token                 | A local credential readable from `GET /`; Cindl requires a sign-in provider instead |
| `/api/fs/*`, `/api/files*`                 | Host filesystem access, not a memory or artifact API                                |
| `connectors.*`                             | Not account coverage; some calls create guest identities                            |
| `vault.*`, `secret`, `sudo` prompts        | Credential entry stays on Hermes's own surfaces                                     |
| Canonical sessions (`prompt.receipt`, ...) | Served only by the gateway's local listener, not by `hermes serve`                  |
| `api_server` and webhook platforms         | Disabled by design                                                                  |

v0.22.6 changes many of these files and adds a "Webapp" mode with same-origin
socket tickets and a browser upload route; none of that exists at v0.22.5.
Cindl stays pinned and reports other versions as untested.

## Live probe

An operator can check their own instance without changing anything:

```sh
node packages/hermes-adapter/scripts/live-probe.ts --origin https://hermes.example.test --token-file ./access-token
node packages/hermes-adapter/scripts/live-probe.ts --origin https://hermes.example.test --cookie-file ./cookie-header
```

`--token-file` holds a native access token (or a stored token set with
`access_token`); `--cookie-file` holds a `Cookie` header value. The probe
calls only `GET /api/status`, `GET /api/auth/me`, `POST /api/auth/ws-ticket`
(one ticket), the `/api/ws` handshake (`client.capabilities` without
`server_requests`, then `gateway.capabilities` or `runtime.describe`) and one
`session.list` whose rows it counts. It prints versions, auth flows, the
authority, offered request kinds and the negotiated capability map. It never
prints tokens, tickets, cookies, session titles or ids, never submits prompts
and never mutates. Exit codes: 0 compatible, 2 usage, 3 not signed in, 4
unreachable, 5 incompatible. Keep the token file out of the repository.

## Not yet verified live

Every statement above comes from reading the pinned source. Before any of it
is called working for a deployment, run the live probe against that instance
and record the result in the acceptance matrix.
