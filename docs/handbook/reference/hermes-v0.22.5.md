# Hermes v0.22.5 transport

Cindl's verified baseline is Hermes **v0.22.5**, commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`, desktop backend contract **8**.
Everything below is taken from the public source at that commit. It has been
read, not yet exercised against a live, authenticated instance.

Machine-readable sources in this repository:

- `packages/hermes-adapter/src/upstream-surface.ts`: the allowlist of methods,
  server requests and notifications.
- `packages/hermes-adapter/src/compat.ts`: REST endpoints, subprotocols, close
  codes.
- `packages/hermes-adapter/upstream/v0.22.5/contract-subset.json`: the vendored
  upstream schemas for exactly that surface (regenerate with
  `node packages/hermes-adapter/scripts/extract-upstream.ts --source <checkout>`).

## REST

| Endpoint                                                       | Auth    | Purpose                                                                                                                       |
| -------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/status`                                              | public  | Discovery                                                                                                                     |
| `GET /api/auth/providers`                                      | public  | Sign-in providers                                                                                                             |
| `GET /api/auth/me`                                             | session | Identity check                                                                                                                |
| `POST /api/auth/ws-ticket`                                     | session | Single-use WebSocket ticket, 30 s TTL                                                                                         |
| `GET /auth/native/authorize`                                   | public  | Start native PKCE sign-in                                                                                                     |
| `POST /auth/native/token`                                      | public  | Exchange code + verifier for tokens                                                                                           |
| `POST /auth/native/refresh`                                    | public  | Rotate the refresh token                                                                                                      |
| `GET /api/skills`                                              | session | Skill list                                                                                                                    |
| `GET /api/skills/content`                                      | session | One skill's content                                                                                                           |
| `GET /api/profiles/{name}/soul`                                | session | Read SOUL.md                                                                                                                  |
| `PUT /api/profiles/{name}/soul`                                | session | Replace SOUL.md                                                                                                               |
| `GET /api/memory`                                              | session | Memory provider metadata (no entry text)                                                                                      |
| `GET /api/learning/graph`, `GET/PUT/DELETE /api/learning/node` | session | Memory entries by fingerprinted id (`memory:<source>:<index>:<fingerprint>`); verification in progress, not used by Cindl yet |

## WebSocket

`/api/ws`, subprotocols `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>`.
JSON-RPC 2.0: requests `{jsonrpc, id, method, params}`; notifications use
`method: "event"` with `params: {type, session_id?, payload, seq?}`.

Legacy sidecar methods (contract 8): `client.capabilities`,
`gateway.capabilities`, `ping`, `session.create`, `session.list`,
`session.active_list`, `session.resume`, `session.activate`, `session.history`,
`session.status`, `session.usage`, `session.title`, `session.archive`,
`session.events.since`, `session.interrupt`, `session.steer`, `session.close`,
`session.most_recent`, `prompt.submit`, `approval.pending`, `approval.respond`,
`request.answer`, `subagent.list`, `process.list`, `cron.manage`,
`skills.manage`, `mcp.servers.status`, `profiles.describe`, `profiles.list`,
`display.status`, `display.observe`, `display.lease.acquire`,
`display.lease.release`.

Canonical methods (only after `session_authority`): `runtime.describe`,
`session.create`, `session.list`, `session.resume`, `session.info`,
`session.events.since`, `session.interrupt`, `session.steer`, `prompt.submit`,
`prompt.receipt`, `prompt.resolve_unknown`, `approval.respond`,
`clarify.respond`, `profiles.list`, `cron.status`.

Server requests Cindl answers: `approval`, `clarify`, through the sidecar's
acknowledged `request.answer`. Hermes broadcasts each request to every attached
client and keeps the first reply. Cindl never replies to sudo, secret or vault
prompts or to kinds it does not know: no 4404 decline, no error, no empty value,
because a unanimous 4404 settles the request with a JSON error string that the
secret callback stores and sudo and vault prompts use as the password or code
(`tui_gateway/server_requests.py:254-278`, `tui_gateway/agent_callbacks.py:250-279`).
They stay open for another Hermes surface. The one non-answer reply Cindl sends
is the 4404 vote for a prompt another app's window owns, and only on a sidecar
socket that counts such votes. See
[ADR 0005](../architecture/decisions/0005-server-requests.md) and
[server requests](server-requests.md).

Notifications handled: `gateway.ready`, `message.start`, `message.delta`,
`message.interim`, `message.complete`, `reasoning.delta`,
`reasoning.available`, `thinking.delta`, `tool.generating`, `tool.start`,
`tool.progress`, `tool.complete`, `tool.output_risk`, `status.update`,
`session.info`, `session.usage`, `session.title`, `sessions.changed`, `error`,
`notice`, `request.cancel`, `approval.cancelled`, `background.complete`,
`cron.changed`, `display.status`, `display.lease`, `subagent.start`,
`subagent.progress`, `subagent.complete`, `skills.changed`,
`session.reclaimed`. Unknown types are ignored, never guessed.

## Display

`display.observe` returns a single-use 30-second ticket and the
`/api/display/ws` path for a binary RFB stream tied to the RPC connection's
viewer identity. Close codes: `4000` evicted controller, `4001` screen
stopped, `4401` ticket expired or used, `4403` Origin/Host rejected, `1003`
non-binary or protocol error.
