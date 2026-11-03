# Architecture overview

Cindl is three clients over one shared core, talking directly to an existing
Hermes `hermes serve` backend. There is no Cindl server.

```text
 ┌──────────── apps/web (React) ─────────────┐   ┌──── apps/android (React Native) ────┐
 │ Talk · Work · Library · Agent             │   │ same destinations, native components │
 │ client-react hooks ← client-core store    │   │ client-react hooks ← client-core     │
 └──────────────┬────────────────────────────┘   └──────────────┬──────────────────────┘
                │ CindlClientApi                                 │ CindlClientApi
   ┌────────────┴───────────┐                                    │
   │ apps/desktop (Electron)│  renderer = apps/web               │
   │ preload: window.cindl… │  main: tokens, Hermes connection   │
   └────────────┬───────────┘                                    │
                │                                                │
        packages/hermes-adapter  (REST + JSON-RPC 2.0 WebSocket, PKCE, redaction)
                │
        hermes serve (existing, authenticated; API server and webhooks stay disabled)
                │
              Hermes agent (the brain: models, tools, memory, skills, routines)
```

## Packages

| Package                 | Responsibility                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `@cindl/contracts`      | Versioned domain model, capabilities, events, the `clientOps` operation surface              |
| `@cindl/hermes-adapter` | Hermes v0.22.5 wire knowledge: endpoints, methods, PKCE, redaction, vendored contract subset |
| `@cindl/client-core`    | Pure reducer and store, selectors, line diff, portable SHA-256, platform interfaces          |
| `@cindl/client-react`   | React provider and hooks (web and Android)                                                   |
| `@cindl/tokens`         | Design tokens, generated CSS, bundled OFL fonts                                              |
| `@cindl/fixtures`       | Synthetic scenario for tests and the labelled demo                                           |

## Data flow

1. A platform builds a `CindlClientApi`: Electron's main process or Android
   runs the direct Hermes client; the Electron renderer reaches it over the
   preload bridge; the synthetic demo uses `@cindl/fixtures`.
2. UI calls operations (`prompt.submit`, `request.answer`, `soul.write`, ...).
   Each operation's arguments are validated against its schema; the desktop
   app's main process is designed to validate them again (in progress).
3. The client emits normalized `CindlEvent`s. `client-core` reduces them into
   one state tree; UI reads it through hooks. Hermes wire events never reach
   components directly.
4. Capabilities are negotiated per connection and gate every feature.

## Connection lifecycle (Hermes v0.22.5)

0. Prerequisite: Hermes runs `hermes serve` (or `hermes dashboard`) in login
   mode. Bound to loopback without a configured public URL, Hermes instead uses
   a per-process token that any local process can read; Cindl never reads or
   uses that token. Hermes has no TLS settings, so HTTPS comes from the
   operator's reverse proxy, and its CORS origins are fixed to localhost.
1. Discover: `GET /api/status`, `GET /api/auth/providers` (public).
2. Authenticate: same-origin cookie session (web) or the native PKCE flow
   (`/auth/native/authorize` → loopback redirect → `/auth/native/token`) for
   desktop and Android. Tokens refresh through `/auth/native/refresh`.
3. Connect: `POST /api/auth/ws-ticket` mints a single-use 30-second ticket; the
   WebSocket `/api/ws` opens with subprotocols `hermes-gateway-v1` and
   `hermes-gateway-ticket.<ticket>`. A new ticket is minted for every reconnect.
4. Handshake: the first frame is `gateway.ready` (replay epoch, heartbeat,
   optional `session_authority`). Cindl immediately sends `client.capabilities`
   with `server_requests: true`. If `session_authority` is true, Cindl
   negotiates `runtime.describe` and uses the canonical protocol; otherwise the
   legacy sidecar (desktop backend contract 8). The two are never mixed.
5. Converse: `prompt.submit` returns `streaming | queued | steered | redirected`;
   output arrives as `message.*`, `tool.*`, `status.update` and related events.
6. Decide: approvals and clarifications are server-to-client JSON-RPC requests;
   Cindl answers each once, by id, with an offered choice, through a path
   Hermes acknowledges. Hermes keeps the first reply from any client. Cindl
   never replies to sudo, secret, vault or unknown prompts, because even a
   decline can become the value Hermes uses; it shows them read-only so another
   Hermes surface can answer (ADR 0005, [server requests](../reference/server-requests.md)).
7. Reconnect: `session.events.since` replays a bounded in-memory window and
   reports `epoch`, `truncated` and `open_requests`. On an epoch change or
   truncation the client reloads history instead of trusting partial replay.
   Prompts whose submission outcome is uncertain are never resent
   automatically (sidecar `prompt.submit` has no idempotency key).

Live validation of this lifecycle against an authenticated Hermes instance has
**not** been performed yet; see the acceptance matrix.

## Trust boundaries

- **Hermes host** is trusted with everything; Cindl adds no new authority.
- **Electron main** holds tokens and the Hermes connection; the **renderer** is
  untrusted (renders agent output) and can call allowlisted operations only.
- **Android app** holds tokens in the Keystore-backed store.
- **Web** relies on Hermes's same-origin session cookie; it requires Cindl to be
  mounted on the `hermes serve` origin, which is a deployment decision not yet
  made.
- **Agent output** is untrusted content in every client.

See the [threat model](../security/threat-model.md) for details.
