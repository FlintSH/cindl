# 0002 Direct to `hermes serve`, no Cindl server

**Status:** Accepted

**Context.** Cindl's verified baseline, Hermes stable v0.22.5 (commit `bf0203a`), exposes an
authenticated `hermes serve` backend: REST under `/api` and JSON-RPC 2.0 over
the `/api/ws` WebSocket, the same surface the official desktop client uses. The
dedicated API-server and webhook platforms are disabled and must stay disabled.
A separate Cindl relay would be a new service to deploy, secure and keep in
sync with Hermes.

**Decision.** Clients talk to `hermes serve` directly through
`@cindl/hermes-adapter`. Compatibility is pinned to v0.22.5 / desktop backend
contract 8; the exact upstream methods, server requests and notifications used
are listed in `upstream-surface.ts` and vendored from the upstream generated
contract at the pinned commit. When `gateway.ready` reports
`session_authority: true`, the adapter negotiates `runtime.describe` and uses
the canonical protocol; otherwise the legacy sidecar. Never both.

**Consequences.**

- No new runtime service, ingress or credential store on the Hermes host.
- The web client can only reach Hermes from the `hermes serve` origin (Origin,
  Host and CORS checks stay as they are). Mounting it there is a separate,
  pending deployment decision; no wildcard CORS.
- A shared profile or database is not proof that the messaging gateway and
  `hermes serve` share one live session; Cindl only claims unified presence
  when the handshake proves it.
- Newer upstream releases are untested until verified; the adapter enables only
  what it can negotiate.
