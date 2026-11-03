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
is fixed at bind time (`hermes_cli/web_server.py:916-945`, with the rules in
`web_server_boundary.py:106-148`):

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
| `GET /auth/native/authorize`               | public  | 302 to the loopback redirect with `code` and `state`                       | `routes.py:242-276, 289-336`               |
| `POST /auth/native/token`                  | public  | `{access_token, refresh_token, token_type, expires_at, provider, user_id}` | `routes.py:111-117, 574-591`               |
| `POST /auth/native/refresh`                | public  | same token set, rotated                                                    | `routes.py:594-617`                        |
| `GET /login`                               | public  | nothing: Hermes's login page, where Cindl only sends the browser           | `routes.py:195-200`                        |
| `POST /auth/logout`                        | public  | 302 to `/login`, session cookies cleared                                   | `routes.py:496-512`                        |
| `GET /api/sessions/{id}/mutation-snapshot` | session | `{session_id, exists, runtime_revision, runtime_generation}`               | `web_routers/sessions.py:586-598`          |
| `PATCH /api/sessions/{id}`                 | session | fenced metadata write, see [Sessions](#sessions)                           | `sessions.py:926-934`                      |
| `GET /api/skills`                          | session | `[{name, description, category, enabled, provenance}]`                     | `web_routers/skills.py:343-376`            |
| `GET /api/skills/content?name=`            | session | `{name, content}` (the host `path` is dropped)                             | `skills.py:397-415`                        |
| `PUT /api/skills/content`                  | session | `{name, content, profile?}`, full rewrite                                  | `skills.py:433-444`                        |
| `GET /api/profiles/{name}/soul`            | session | `{content, exists}`                                                        | `web_routers/profiles.py:1000-1012`        |
| `PUT /api/profiles/{name}/soul`            | session | `{content}`, atomic full rewrite                                           | `profiles.py:1015-1034`                    |
| `GET /api/memory`                          | session | `{active, providers[], builtin_files{memory, user}}`, sizes only           | `web_routers/ops.py:494-509`               |

Session endpoints accept the cookie session, or
`Authorization: Bearer <access token>` from the native flow, verified by the same provider stack
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
  (`native_flow.py:145-158`, `routes.py:574-591`).
- `POST /auth/native/refresh {refresh_token, provider?}`: 401
  `{error: "session_expired"}` when every provider rejects the token, 503 when
  one is unreachable (`routes.py:594-617`). Cindl rotates once per expiry,
  shares one refresh between concurrent requests, forgets tokens on 401 and
  keeps them on 503.
- Tokens live in the OS-backed store only (Electron `safeStorage`, Android
  Keystore), one record per origin under `nativeTokensKey(origin)`
  (`cindl.hermes.native-tokens.v1|<origin>`), which the adapter exports so a
  platform migration never repeats the format. Without a store, Cindl keeps
  them in memory and says so. Sign-out is
  local: logout does not revoke native tokens, which are stateless (basic
  provider defaults: 12 h access, 30 d refresh). Sign-out always deletes the
  stored record, even when the store has stopped encrypting, since its
  delete may still work; a delete that fails is logged.
- Signing in to another origin is all or nothing in the direct client. A
  working session, with its link, tokens and connection, stays as it is
  until the new sign-in succeeds; a failed or cancelled one leaves it usable
  and the error is rethrown. Without a working session the attempt shows as
  `connecting`, and a failure ends `signed-out` (or `incompatible` for a
  loopback-token Hermes) with the error as `lastError`.
- A switch that succeeds retires the previous origin's sign-in before the
  new one is installed (`NativeAuth.retire`). Work it still has in flight, a
  token refresh above all, can no longer store, return or delete tokens, and
  nothing uses its tokens again. So a record the platform deletes for the
  origin it left stays deleted, and a late answer never writes over or
  deletes the record of the new origin, or of the same origin signed in
  again under the same key. A failed or cancelled switch retires nothing:
  its refresh may still store. Signing in to the same origin again is no
  switch, and sign-out is unchanged.

### Web sign-in (cookie)

The web client is served from Hermes's origin and runs the direct client with
`auth: 'same-origin-cookie'`. It never handles a password or a token. Hermes's
HttpOnly session cookies (`hermes_session_at`, `hermes_session_rt`,
`hermes_session_provider`; `cookies.py:27-29, 60, 90-128`) ride on its
same-origin requests, and it keeps nothing in browser storage.

- Sign-in happens on Hermes's own page, `GET /login` (`routes.py:195-200`). Its
  password form posts the provider, username, password and `next` to
  `/auth/password-login`, which sets the cookies and answers
  `{ok: true, next}` (`routes.py:447-494`, `login_page.py:401-430`); OAuth
  providers go through `/auth/login`. Cindl calls neither, so neither is
  pinned: it only sends the browser to the page. The page, both sign-in routes
  and `/auth/logout` are on the gate's public list (`middleware.py:39-42`).
- `loginPagePath(next)` builds that link. Hermes percent-decodes `next` twice
  before it lands there (`_validate_post_login_target`, `routes.py:93-97`, at
  the page and again at the login, `routes.py:171`), so Cindl escapes each `%`
  twice; a test round-trips paths through the fake's page. A `next` that
  `is_safe_next_path` refuses (not a same-origin path, the login or auth
  routes, or under `/api`; `request_utils.py:16, 37-44`) is left out, and
  Hermes lands on `/`.
- `isSafeNextPath` is stricter than Hermes: it also refuses a backslash or a
  control character. Hermes accepts `/\host`, or a tab between two slashes,
  which a browser resolves to another origin, and its page navigates to the
  landing path after sign-in (`login_page.py:427`). So a crafted link to
  Hermes's `/login` redirects off-site at v0.22.5. Cindl never builds one; the
  fix belongs upstream.
- `auth.signIn` checks `GET /api/auth/me` with the cookie. Without a session it
  fails with "Sign in on the Hermes login page, then try again." and the link
  stays `signed-out`. The socket needs no cookie: the ws-ticket is minted with
  it and travels in the subprotocol, a fresh one on every reconnect. The agent
  screen works the same way, through the ticket `display.observe` returns.
- The gate rotates an expired access cookie through the refresh cookie on the
  next request and sets the new cookies on that answer
  (`middleware.py:135-147, 192-211`). Requests of one burst that carried the
  same stale refresh cookie share that rotation for 30 s
  (`middleware.py:222-238`, `refresh_singleflight.py:1-28`).
- A 401 whose `error` is `unauthenticated` or `session_expired` is the gate
  saying the browser's session is over: the refresh failed and it cleared the
  dead cookies (`middleware.py:150-157`), or no cookies came at all, as after a
  sign-out in another tab. The direct client then stops, closes the socket and
  goes `signed-out` with that error, whether an operation or the background
  memory probe met it. Hermes's own web app goes to the login page on exactly
  these two (`web/src/lib/api.ts:209-240`). Any other 401, and any other
  refusal, fails only its call. Native mode is unchanged: it refreshes its
  tokens itself.
- Hermes checks a session only when a socket opens (`chat_ws.py:137-171`), so
  a socket outlives the cookies that opened it: a sign-out in another tab
  clears the cookies the tabs share, not this tab's socket. In cookie mode the
  direct client therefore asks `GET /api/auth/me` on its 15 s request tick and
  whenever the platform's `watchSession` cue fires, such as a page becoming
  visible again; the gate's 401 then ends the session as above. Cues share
  the one request in flight, any other failure waits for the next check, and
  native mode never asks.
- `auth.signOut` posts `POST /auth/logout` (`routes.py:496-512`). Hermes clears
  the cookies, which only it can do since they are HttpOnly, and answers a 302
  to `/login`, an opaque redirect to a browser under `redirect: 'manual'`.
  Cindl takes only that as confirmation. A failure never blocks the local
  sign-out: the link still goes `signed-out`, with a warning notice to sign
  out again. The result stays `{localOnly: true}`, since Hermes v0.22.5 cannot
  end the session on its side. Every bundled provider's revoke is a no-op
  (`plugins/dashboard_auth/basic/__init__.py:165-167`,
  `nous/__init__.py:67-70`, `drain/__init__.py:106-107`), so a copy of the
  cookies keeps working until it expires (basic defaults: 12 h access, 30 d
  refresh).

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
   a host the listener accepts: the bound host (any loopback alias on a
   loopback bind), a `public_url` host, or any host on a 0.0.0.0 or :: bind
   (`web_server_boundary.py:79-103, 192-218`).
   A refusal at this stage is a close before accept, which uvicorn delivers as
   an opaque **HTTP 403**: a bad, used or expired ticket and a refused Origin
   look the same to the client (the display route documents this,
   `web_routers/display.py:77-84`). Cindl retries with a fresh ticket and
   backoff and, after repeated refusals, names Host/Origin as the likely cause.

### Handshake

- The first frame is `{method: "event", params: {type: "gateway.ready",
payload: {skin, change_events, heartbeat, replay_epoch,
session_authority?}}}` (`tui_gateway/ws.py:548-554`).
- Cindl immediately sends `client.capabilities {server_requests: true}`. A
  session's server request reaches every client attached to the session,
  advertised or not (`tui_gateway/transport.py:284-325`). The advertisement
  matters when no attached client made it: Hermes then sends nothing and an
  approval is withdrawn at once (`server_requests.py:30-34, 156-161`;
  `session_transports.py:58-67`; `server.py:849-859`). The result lists every server-request method of the
  build and `declines_not_shown: true` (`methods_voice.py:521-539`).
- `session_authority: true` appears only when a session authority is attached.
  The gateway attaches one when it hosts the dashboard listener or redeems a
  local ticket (`gateway/run_api.py:63-71, 366`); a standalone `hermes serve`
  has none, so its `/api/ws` runs the legacy sidecar dispatcher
  (`ws.py:357-379`). On a canonical socket Cindl negotiates
  `runtime.describe` and uses only canonical method names, but it does not
  implement canonical sessions yet, so chat features report `unsupported`
  there. On the sidecar it probes `gateway.capabilities`
  (`{per_session_exclusive_submit}`).

### Framing and liveness

- One JSON-RPC 2.0 object per text frame both ways. Client ids are integers;
  Hermes's server-request ids are `srq-<12 hex>` strings, so they never
  collide (`server_requests.py:9-13`).
- Requests run one at a time per connection in arrival order
  (`ws.py:94-98, 501-509`); long handlers run on a worker pool, so the queue
  keeps moving (`rpc_dispatch.py:62-88`). Only response frames to server
  requests and `clarify.lock` skip it (`ws.py:107-115, 502-504`):
  `request.answer`, which Cindl answers with, waits its turn.
- Unknown params keys answer JSON-RPC error **4000** ("out of sync");
  unknown methods **-32601** (`tui_gateway/rpc_dispatch.py:22-31`,
  `contracts/registry.py:89-118`). Cindl treats either for a method on its allowlist as a
  version mismatch and marks the link `incompatible`.
- Heartbeat: Cindl sends `ping` (on the contract, `{pong: true}`) every 15 s
  and treats 45 s without any inbound frame as a dead socket. Hermes also
  answers a transport-level `gateway.ping` on the reader; it is outside the
  generated contract, so Cindl does not use it.

### Methods Cindl calls (legacy sidecar, contract 8)

`client.capabilities`, `gateway.capabilities`, `ping`, `session.create`,
`session.list`, `session.resume`, `session.title`, `session.events.since`,
`session.interrupt`, `prompt.submit`, `request.answer`, `cron.manage`,
`mcp.servers.status`, `display.status`, `display.observe`,
`display.lease.acquire`, `display.lease.release`. The allowlist in
`upstream-surface.ts` also names methods Cindl may use later
(`session.history`, `session.steer`, `process.list`, ...). Anything off the
allowlist is refused before it reaches the wire, including every
`connectors.*` call and both `approval.respond` verbs: the sidecar's resolves
the approval a `request_id` names, else the oldest pending one, and takes an `all`
flag (`methods_prompt.py:1325-1339`, `tools/approval.py:142-160`),
and the canonical one is keyed by a `prompt_id` Cindl does not use (see
[Answering](#answering)).

## Sessions

- A stored session id (`YYYYMMDD_HHMMSS_<6 hex>`) is durable; a runtime id
  (8 hex) names a live agent in one process (`hermes_state_ids.py:53-62`,
  `methods_session.py:65-67`). Events carry runtime ids; REST takes stored ids.
- `session.create {title?, close_on_disconnect: false, idempotency_key?}`
  returns both ids. The stored row appears with the first prompt.
  `close_on_disconnect` defaults to false; detached sessions are reaped after
  `dashboard.ws_orphan_reap_grace_s` (20 s) unless a client re-attaches
  (`config_defaults.py:1034-1041`; a detached turn that is still running is
  interrupted only once it has been idle for 600 s).
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

Hermes sends a session's request to every client attached to the session,
whether or not it advertised `server_requests` (`transport.py:284-325`); the
**first answer wins** and settles it for all. A reply for an id that is no longer open is dropped
(`server_requests.py:1-35, 191-248, 281-317`). Unanswered requests are listed
again, with the same `srq-<12 hex>` id, in the `open_requests` of
`session.resume` and `session.events.since` (`server_requests.py:71,
365-369`; `server.py:797-810`). Hermes withdraws a request with
`request.cancel {id, method, reason}`; `reason: resolved` means an approval
was settled from another surface such as `approval.respond`, a chat platform
or `/approve` (`approval_gateway_wait.py:201-221`). When another client
answers with a response frame, the sidecar tells the other clients nothing:
no event and no cancel (`rpc_dispatch.py:54-58`, `server_requests.py:281-317`).

### Approval and clarify

| Request    | Params                                                                                                                                  | Result Cindl sends                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `approval` | `{session_id, request_id, command (redacted by Hermes), description, choices, allow_session, allow_permanent, smart_denied, tool_name}` | `{choice: "once" \| "deny"}`, never `all`, never `session`/`always` |
| `clarify`  | `{session_id, questions[{qid, question, choices?, multi_select}], answers?}`                                                            | `{answers: {qid: string \| null}}` for the open questions           |

- Choices default to `once` (+ `session`, `always` unless smart-denied or
  disallowed) + `deny` (`server.py:781-794`). Cindl offers only the
  intersection with `once`/`deny` and lists the rest as withheld.
- A multi-select answer is a JSON array string, which Hermes parses
  (`tools/clarify_tool.py:36-47`); `null` marks a skipped question.
- `answers` on a re-listed clarify request holds the answers other clients
  already locked with `clarify.lock` (`server_requests.py:93-99`). Hermes lays
  a reply over the locks (`tools/clarify_batch.py:27-31`), so Cindl shows them
  and sends only the questions that are still open.
- Approvals wait `approvals.timeout` (default 300 s,
  `tools/approval_context.py:305-313`); clarify waits `clarify.timeout`
  (default 3600 s, `tools/clarify_gateway.py:296-308`). Both fail closed and
  announce the end with `request.cancel`; interrupts also emit
  `approval.cancelled`. Cindl does not guess a local deadline because the
  windows are configurable.

### Answering

Cindl answers with `request.answer {id, result}`
(`methods_prompt.py:1289-1302`), never with a bare JSON-RPC response frame.
Both settle the request the same way (`resolve_response`), but only the method
is acknowledged: `{status: "ok"}` when Hermes's request registry took the
answer, `{status: "expired"}` when nothing waits for that id anymore. A
response frame gets no reply at all (`rpc_dispatch.py:54-58`). The method has
no error form, so it can neither decline nor withdraw a request. Missing or
malformed fields answer error 4002 and leave the request open (Hermes checks
only unknown keys before the handler, `rpc_dispatch.py:24-30`).

Each answer ends Cindl's `answering` state with exactly one event:

- `ok`: `request.closed` with status `answered`. Hermes accepted the answer;
  that says nothing about whether the command or tool then succeeded.
- `expired`: `request.closed` with status `resolved-elsewhere`. Another
  client answered first, or Hermes withdrew it or timed it out.
- The call was not sent, Hermes refused it, or no acknowledgement came back:
  `request.answer-failed`, and the request is answerable again. Answering
  again is safe: if the first answer did land, Hermes says `expired`.

Each attempt is identified by the connection it is sent on. Cindl re-emits
the request as `answering` with that connection's epoch as `lastSeenEpoch`,
and every outcome carries the same `connectionEpoch`; an `answered` close also
carries the answer Hermes acknowledged. A history load can re-list a request
while an answer is in flight, because `session.resume` runs in Hermes's worker
pool (`server.py:180-199`) and its snapshot can predate an answer handled
meanwhile; once Hermes acknowledges, that copy is dropped.

The session owner (canonical) surface works differently and Cindl does not
use it: approvals arrive as `approval.request` events and clarify questions
as `clarify.request` events, one per question, each keyed by a `prompt_id`
(the approval's 32-hex `request_id` or a 10-hex clarify id;
`gateway/session_pending_controls.py:20-50`, `tools/approval_gateway_wait.py:32`,
`gateway/run_turn_runner.py:606`). They are answered with
`approval.respond` / `clarify.respond {session_id, execution_generation,
prompt_id, choice | answer}`, which return `resolved` or `already_resolved`
(`gateway/session_controls.py:840-850`, `session_pending_controls.py:65-101`;
contracts `tui_gateway/contracts/canonical.py:356-369` for `clarify.respond`
and `canonical_sessions.py:286-288, 328` for `approval.respond`).

### Tracking after a reconnect

Nothing about requests is stored on the device. After a reconnect Cindl
re-attaches each conversation, replays the events it missed (a replayed
`request.cancel` closes a request with Hermes's reason), offers every request
Hermes still lists (one this device had answered becomes answerable again:
that answer did not land), then emits `requests.synced {conversationId,
openRequestIds}`. Any other request it showed as open in that conversation
ended without an event. A request that arrives while that list is on its way
is newer than the list and stays open; one that arrives before the reply that
binds its session (`session.resume` attaches before it answers) is shown once
the binding lands. While a card is open Cindl repeats the check every 15 s,
because the sidecar does not report answers from other clients. Every
`requests.synced` carries the `connectionEpoch` its list came from, so a list
from an older connection cannot close a request seen on a newer one.

The link goes online only once every conversation is re-attached. If Hermes
answers a conversation's `session.resume` with an error (not found, or a
failure on its side), that session counts as gone on this socket: it is
detached, its requests close, the other conversations still re-attach, and
opening it later tries again. If a re-attach times out while the socket is
still up, Cindl drops that socket and reconnects with a fresh ticket instead
of going online with conversations left unattached, whose events and requests
would reach no one; repeated stalls back off like failed connects.

### Skipping a clarify set

Cindl never sends an empty `{}` result. Hermes reads it as cancel-all: locked
answers stay, the rest are unanswered, and the outcome is `cancelled`
(`tools/clarify_batch.py:15-31`; the owner path does the same,
`gateway/session_clarify_batch.py:32-42`). The model then gets
`{responses: [{status: "unanswered", user_response: null}, ...], outcome:
"cancelled"}` with no notice (`server.py:1112-1121`,
`tools/clarify_tool.py:87-108`), the same result an interrupt or a withdrawn
request produces (`server_requests.py:339-352`), so it cannot tell that the
user chose not to answer. "Skip all" instead answers every open question with
`null`: the outcome is `submitted` and each question is `skipped`.

### Requests Cindl does not answer

Any reply settles a request for every client, so Cindl's non-answer depends
on the kind. Whatever Cindl leaves open appears in its conversation as a
read-only `unsupported` request (`unsupportedKind` sudo, secret, vault or
other) with a title only, nothing from Hermes's params, and closes like any
other request: withdrawn, timed out, or gone from Hermes's open list once
another surface answered it. A prompt that belongs to no session (Hermes sends
`display.install.sudo` with an empty `session_id`, `methods_display.py:202-206`)
has no conversation and shows only in Work. It belongs to the surface that
started the operation (Hermes writes the frame only there, and Cindl starts
none), but `session.events.since` with `session_id: ""` lists every
connection's open app-level prompts (`methods_session.py:2309-2323`,
`server.py:797-810`). Cindl reads that list after every connect and in the
15 s check, which runs whenever it is signed in, so a prompt another surface
starts shows within 15 s. It shows the ones it has not seen and closes only
what the list no longer holds. A disconnect cancels nothing app-level (Hermes waits out the
prompt's own timeout), so if the list cannot be read nothing changes. When
Hermes reclaims a session (`session.reclaimed`,
`session_lifecycle.py:545-560`), its open requests close as `cancelled`.

| Kind                                                                                              | Cindl's reply                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview.act`, `preview.read`, `terminal.read`, `theme.apply`, `window.read`, `tour`              | error **4404** ("not shown"), only on a sidecar socket that reports `declines_not_shown`; otherwise nothing | Window-owned bridges. On the sidecar 4404 is one client's vote: Hermes settles a session's request only when every answering client attached to that session declined, then hands the tool `{"success": false, "error": "No Hermes Desktop window is showing this chat..."}`, which it returns to the model as a refusal (`server_requests.py:24-28, 117-121, 254-279`; `agent_callbacks.py:145-150, 169-176`; `server.py:1155-1161, 1213-1226`; `theme_bridge.py:21-23`). The session owner settles on any error reply, 4404 included (`gateway/session_server_requests.py:74-93`), and a canonical socket still reports `declines_not_shown` through the sidecar handler (`ws_legacy_fallback.py:53-63`, `methods_voice.py:539`), so Cindl never declines there. An app-level request (empty `session_id`) has no attached clients, so no vote ever settles it (`server_requests.py:264-271`); Cindl sends nothing and shows it read-only in Work. |
| `sudo`, `display.install.sudo`, `secret`, `vault.unlock_prompt`, `vault.save_login`, `vault.code` | **nothing**, ever                                                                                           | These read the reply's `value` as the password, code or secret (`server.py:1092-1097`). Once every client attached to the session declined with 4404, Hermes settles a session's request, these included, with the non-empty "not shown" string (`server_requests.py:254-278`): `secret_cb` would store it as the secret (`agent_callbacks.py:251-254`), and sudo, `vault.unlock_prompt` and `vault.code` would try it as the password or code (`agent_callbacks.py:256-266, 278-279`); `vault.save_login` discards it because it is not JSON (`agent_callbacks.py:268-275`). `display.install.sudo` is app-level (`methods_display.py:202-206`), which no vote settles. An error reply or an empty value settles the request as skipped for every client (`server_requests.py:301-303`; `gateway/session_server_requests.py:84-90`). It stays open for the terminal or the desktop app, or Hermes's own deadline ends it.                           |
| `theme.pick`, `setup_beat`, unknown kinds                                                         | **nothing**                                                                                                 | Any reply would settle the request before the client that can answer it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
character limit (`web_routers/skills.py:398-413`,
`tools/skill_manager_tool.py:110, 183-186, 240`). SOUL.md writes are
atomic (temp file and replace) and the profile name is validated and must
exist (`web_server_profiles.py:190-199`). Cindl re-reads and compares the
SHA-256 of the version the owner reviewed before writing, which narrows but
cannot close the race; both capabilities are `limited`.

### Which profile

Hermes serves one profile (`hermes -p <name> serve`); an omitted, empty or
`current` profile means that one (`web_server_profiles.py:31-34`). A named
profile is a different thing: `default` under `hermes -p work serve` is
another profile's home, and naming one on a profile-scoped route also
switches the process to multi-profile hosting and loads that profile's
secrets (`web_server_profiles.py:296-311`). So unless the platform pins a
profile, Cindl sends none on `GET /api/memory` and the learning routes.
SOUL.md routes need a name in the path; Cindl uses the `profile` that
`display.status` reports for the served home (`contracts/display.py`,
`tools/bot_desktop/runtime.py:641-646`). Until that answer arrives,
`soul.read` and `soul.write` are unknown; a home outside `profiles/` reports
`custom`, which names nothing, so both are then `unavailable`.

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
  is `sha256(entry.strip())[:12]` (`learning_graph.py:143-158`). Cindl
  strips with Python's whitespace set, not `trim()`'s: it includes U+001C to
  U+001F and U+0085 and leaves U+FEFF. Hermes
  resolves the fingerprint under the memory store's file lock, re-reads, and
  refuses with "memory node id is stale" when no entry has that text any more
  (`learning_mutations.py:52-112`). The id is therefore a per-entry
  compare-and-swap version.
- Ids without a fingerprint resolve by position (`learning_mutations.py:72-80`);
  ids outside the `memory:` namespace address skills on the same routes
  (`learning_mutations.py:127-133, 182-207`). Cindl refuses both.
- A replacement may not push the file past its character limit: MEMORY.md
  2200, USER.md 1375 by default (`tools/memory_tool.py:47-60`,
  `learning_mutations.py:108-113`). Empty text is refused; delete instead.
- There is no undo. An edit or delete rewrites the file atomically and keeps
  no copy (`tools/memory_tool_store.py:338-367, 676-683`). A `.bak.<ts>`
  snapshot is written only when Hermes refuses to touch a file that drifted
  (an entry longer than the whole limit), and that refusal message contains a
  host path, which Cindl never shows (`memory_tool_store.py:49-60, 685-700`).
- The dashboard edit path does not run the memory tool's injection scan, and
  memory enters the system prompt as a snapshot at session start, so edits
  apply to new sessions (`tools/memory_tool.py:2-4`; the tool scans only its own
  add and replace, `memory_tool_store.py:28-31, 374, 402`, and
  `learning_mutations.py:99-114` does not).
- Wrong profile: 400 for an invalid name, 404 for an unknown one
  (`web_server_profiles.py:190-199`).

In Cindl: `memory.entries` lists the cards, `memory.read` reads one entry,
`memory.write` replaces it (after a reviewed diff, with `confirm: true`) and
returns it under its new id, and `memory.delete` removes it (with
`confirm: true`, permanently). They take the exact fingerprinted id and refuse
positional ones before anything is sent. A stale id answers `conflict`, text
over the store's limit `invalid`, and Hermes's own messages, which can hold
host paths, are never shown. The capability `memory.text` is `available` only
once a read-only `GET /api/learning/graph` answered (probed once per sign-in,
for the served profile unless the platform pinned one); a 404 makes it
`unsupported`. Cindl never reads memory through `/api/fs/*` or
any other filesystem route, and never uses `POST /api/memory/reset`.

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
  (`tui_gateway/methods_display.py:50-57`). Hermes broadcasts the same
  snapshot as a `display.status` event when the screen starts or stops
  elsewhere (`methods_display_watch.py:81-103`). Cindl never calls
  `display.start`, `display.stop` or `display.install`.
- `display.status` and `display.lease` events reach every client for every
  profile Hermes hosts (`methods_display.py:38-47`); only `profile_key`, the
  profile's home path, tells them apart. Cindl takes the served profile's key
  from its own `display.status` or `display.observe` answer, keeps only its
  SHA-256 and never emits it, and ignores display events for any other key
  (and all of them until that answer arrives).
- `display.observe` mints a single-use 30 s ticket for `/api/display/ws`
  (`?display_ticket=`) and a viewer id bound to the calling connection
  (`methods_display.py:113-168`). It refuses a stopped screen with error 5300
  and a hint to call `display.start`; Cindl re-reads the status and reports
  that the screen is not running instead.

### Live picture

The direct client shows the screen (ADR 0012) in
`packages/client-core/src/direct/screen.ts` when the platform supplies a
`BinaryWebSocketFactory`. Without one, `computer.view` stays limited and
`display.watch` is refused.

- `display.watch` calls `display.observe` and opens the pinned
  `/api/display/ws` route on the Hermes origin (`wss:` for an `https:`
  origin) with the ticket. Any other path in the reply is refused before a
  socket opens, so the ticket never leaves that route. The binary frames feed
  the shared RFB client.
- One view at a time. Watching again keeps the viewer id this connection
  minted (Hermes honours a requested id only for the connection that minted
  it, `methods_display.py:127-136`), so a lease taken before watching applies
  to the view. Watches run one after another, so two racing calls leave one
  socket and the later view; ending a view settles its handshake at once, and
  sign-out or `stop()` also cancels a watch still waiting for its ticket.
- `display.frame` returns what changed, waiting up to 2 s for a change. A new
  socket, and a screen that just changed size, start as a black framebuffer,
  and a frame has no regions until an update carries pixels (a Raw or
  CopyRect rectangle); a first Raw frame of a 1280x800 screen is 4 MB, so
  slow links wait. TigerVNC, Hermes's Xvnc, announces a resize in an update
  holding only the DesktopSize rectangle and repaints in a later one, so that
  update paints nothing; neither does an empty update, though the pull goes
  on after it. At most one update request is in flight, the client's own
  whole-screen request after a resize included.
- `display.input` sends pointer and key events only while this connection's
  viewer holds the lease, which is what `leaseHeldByThisDevice` reports.
  Hermes's `RfbClientFilter` drops keyboard, pointer and clipboard messages
  from every other viewer as well (`tools/bot_desktop/rfb_filter.py:20, 76-77`).
- `display.acquireControl` names the watching viewer's id. After a reconnect
  that id belongs to a closed connection, so input waits; taking control opens
  the view again under a fresh id and then acquires the lease for it.
- Closing: `display.unwatch` while the link is online, sign-out and `stop()`
  close the socket with 1000, which hands control back as closing Hermes's
  viewer window does. Every other close Cindl makes uses 4100: unwatching
  while the link is down, reopening the view, a stalled handshake, an RFB
  protocol error. Hermes treats that as a dropped link and keeps the human's
  control (`web_routers/display.py:234-240`), so a link that drops while the
  owner is in control never hands the screen to the agent unseen.
- `display.unwatch` skips the capability check: it only closes a view on this
  device, and it is needed exactly when the screen stops being available.
- When Hermes closes the view: on 4000 (another human took control) Cindl
  observes again with the same viewer id and keeps watching without control.
  A screen that stops mid-view ends the RFB stream, and Hermes closes with a
  plain 1000 like any clean end, so Cindl asks `display.status`: the view
  ends as not running if the screen stopped, otherwise as ended. Frames wait
  for that answer.
- Liveness: RFB has no heartbeat and a still screen sends nothing, so after
  15 s without a byte Cindl asks for one pixel, a non-incremental update
  request an RFB server answers at once (RFC 6143, 7.5.3). If nothing arrives
  within 10 s more, the view ends as stalled and the socket closes with 4100,
  so the human keeps control.
- An open view keeps the agent's screen running. The bridge stamps the
  screen's activity on the chunks it relays, at most once a minute
  (`web_routers/display.py:35, 168-187`), and Hermes's idle stop
  (`bot_desktop.idle_stop_minutes`, 30 by default) counts an attached viewer
  as use (`tools/bot_desktop/runtime.py:414-419, 452-465`). The liveness probe
  above keeps bytes flowing on a still screen, so a view left open, on Work >
  Computer over a weekend for example, keeps the screen up the whole time;
  closing the view lets the idle stop run again.
- Frames, input and the ticket URL are never logged. Diagnostics record the
  close code, a stall or an RFB protocol error, nothing else.
- `display.lease.acquire {viewer_id}` and `display.lease.release {viewer_id}`
  accept only viewer ids minted on the same connection
  (`methods_display.py:139-146, 232-261`), except that a release with
  `force: true` skips that check (`:254`). A release that names a viewer id
  still releases only a lease that id holds, force or not
  (`tools/bot_desktop/lease.py:204-226`). The lease shows the holder only as
  `viewer_hash = sha256(viewer_id)[:12]` (`lease.py:67`), which is how Cindl
  recognises its own lease. After a reconnect Cindl keeps its earlier viewer
  ids in memory (never emitted or logged) and hands back a lease one of them
  holds with `force: true`; it never names another viewer's id.
- Display close codes (`web_routers/display.py:37-42`): 4000 evicted
  controller; 4001 no screen to bridge, only as a socket opens (`:131-136`);
  4401 ticket missing, expired or used, after accept (`:86-89`); 1003 a
  non-binary frame or a malformed RFB stream (`:198-205`); 1000 when the RFB
  stream ends, which is how a screen that stops mid-view shows
  (`:181-185, 241-244`). Host/Origin is refused before accept (`:80-84`), so a
  client sees an HTTP 403 handshake failure, not a 4403 close code.

## Allowlisted surface

The adapter sends nothing outside `upstream-surface.ts` and `compat.ts`, and
the vendored contract subset holds exactly these names (its hash is pinned).
Listing a name here does not mean Cindl uses it; what each one is for is in the
sections above.

- Legacy sidecar methods Cindl calls: `client.capabilities`, `gateway.capabilities`, `ping`, `session.create`, `session.list`, `session.resume`, `session.title`, `session.events.since`, `session.interrupt`, `prompt.submit`, `request.answer`, `cron.manage`, `mcp.servers.status`, `display.status`, `display.observe`, `display.lease.acquire`, `display.lease.release`.
- Legacy sidecar methods allowlisted for planned features, not called yet:
  `session.active_list`, `session.activate`, `session.history`, `session.status`, `session.usage`, `session.archive`, `session.steer`, `session.close`, `session.most_recent`, `approval.pending`, `subagent.list`, `process.list`, `skills.manage`, `profiles.describe`, `profiles.list`.
- Canonical methods, used only on a socket with a session authority, where
  Cindl calls `runtime.describe` and nothing else yet: `runtime.describe`, `session.create`, `session.list`, `session.resume`, `session.info`, `session.events.since`, `session.interrupt`, `session.steer`, `prompt.submit`, `prompt.receipt`, `prompt.resolve_unknown`, `profiles.list`, `cron.status`.
- Server requests Cindl answers: `approval`, `clarify`.
- Notifications Cindl maps: `gateway.ready`, `message.start`, `message.delta`, `message.interim`, `message.complete`, `reasoning.delta`, `reasoning.available`, `thinking.delta`, `tool.generating`, `tool.start`, `tool.progress`, `tool.complete`, `tool.output_risk`, `status.update`, `session.info`, `session.usage`, `session.title`, `sessions.changed`, `error`, `notice`, `request.cancel`, `approval.cancelled`, `background.complete`, `cron.changed`, `display.status`, `display.lease`, `subagent.start`, `subagent.progress`, `subagent.complete`, `skills.changed`, `session.reclaimed`.
- REST endpoints: `GET /api/status`, `GET /api/auth/providers`, `GET /api/auth/me`, `POST /api/auth/ws-ticket`, `GET /auth/native/authorize`, `POST /auth/native/token`, `POST /auth/native/refresh`, `GET /login`, `POST /auth/logout`, `GET /api/sessions/{id}/mutation-snapshot`, `PATCH /api/sessions/{id}`, `GET /api/skills`, `GET /api/skills/content`, `PUT /api/skills/content`, `GET /api/profiles/{name}/soul`, `PUT /api/profiles/{name}/soul`, `GET /api/memory`. The memory-entry routes
  `GET /api/learning/graph`, `GET /api/learning/node`, `PUT /api/learning/node`, `DELETE /api/learning/node` back the `memory.*` operations.

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

An operator can check their own instance without changing anything. The
first live check needs no credentials:

```sh
node packages/hermes-adapter/scripts/live-probe.ts --origin https://hermes.example.test --discover
```

`--discover` reads only the two public routes, `GET /api/status` and
`GET /api/auth/providers` (public at v0.22.5,
`dashboard_auth/middleware.py:39-43`), and answers one question: can this
Hermes sign Cindl in at all? It prints the version and whether it is the
verified baseline, whether auth is required, the auth flows Cindl knows
(others are only counted), and how many providers are registered and how
many can sign in with native PKCE. Those are the interactive session
providers (`dashboard_auth/registry.py:93-96`): the ones
`GET /api/auth/providers` lists, that put `native_pkce` in `auth_flows`
(`web_routers/status.py:383-405`) and that `/auth/native/authorize` accepts
(`dashboard_auth/routes.py:203-212, 279-320`). It prints no provider name,
id, host or token: the origin shows as `https://[redacted]`. It never reads
a file or sends a credential, even when `--token-file` or `--cookie-file` is
given, never opens a socket and never calls `/auth/native/authorize`, which
creates sign-in state. The origin must pass the rule sign-in uses (below).

- **0:** a provider supports native PKCE, so Cindl can sign in.
- **5:** incompatible. Hermes runs in loopback-token mode, or no provider can
  sign in with native PKCE, so no Cindl client can sign in until that
  changes.
- **4:** unreachable, or a public read failed without Hermes's own answer (a
  proxy's 503 is not "no providers").
- **2:** usage.

The signed-in mode then checks what needs the owner's own sign-in:

```sh
node packages/hermes-adapter/scripts/live-probe.ts --origin https://hermes.example.test --token-file ./access-token
node packages/hermes-adapter/scripts/live-probe.ts --origin https://hermes.example.test --cookie-file ./cookie-header
```

`--token-file` holds a native access token (or a stored token set with
`access_token`); `--cookie-file` holds a `Cookie` header value. The origin
must pass the rule sign-in uses (https, or plain http only on 127.0.0.1 or
[::1]); anything else exits 2 before a request is sent, so the token or
cookie never travels in clear text. Beyond `GET /api/status` it calls only
`GET /api/auth/me`, `POST /api/auth/ws-ticket` (one ticket), the `/api/ws`
handshake (`client.capabilities` without `server_requests`, then
`gateway.capabilities` or `runtime.describe`) and one `session.list` whose
rows it counts. So it adds the signed-in identity, the authority, the
offered request kinds and the negotiated capability map. It never prints
tokens, tickets, cookies, session titles or ids, never submits prompts and
never mutates. Exit codes: 0 compatible, 2 usage, 3 not signed in, 4
unreachable, 5 incompatible. Keep the token file out of the repository.

## Not yet verified live

Every statement above comes from reading the pinned source. Before any of it
is called working for a deployment, run the live probe against that instance
and record the result in the acceptance matrix.
