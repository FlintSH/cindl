# packages/hermes-adapter

Everything Cindl knows about the Hermes wire protocol lives here. Read
`docs/handbook/reference/hermes-v0.22.5.md` and ADRs 0002, 0003 and 0005 first.

What exists: `rest.ts` (REST client), `native-auth.ts` (RFC 8252 sign-in),
`rpc.ts` + `connection.ts` (JSON-RPC channel, ticketed connect, reconnect),
`requests.ts` (approval/clarify), `normalize.ts` (events), `mappers.ts`,
`negotiate.ts` (capabilities), `wire.ts` (every upstream shape Cindl reads),
`memory-entries.ts` (memory entries by fingerprinted id), `redact.ts`, and the read-only
`scripts/live-probe.ts`. The direct client that uses them is in
`packages/client-core/src/direct`, including the live screen (`screen.ts`).
Planned, not built: canonical sessions, steer and process operations.

- Use only names in `src/upstream-surface.ts` and paths in `src/compat.ts`.
  Adding one is a contract change: cite the upstream file at the pinned commit,
  regenerate `upstream/v0.22.5/contract-subset.json` with
  `scripts/extract-upstream.ts` (its SHA-256 is pinned in a test), and update
  the reference page. Never hand-edit the vendored subset.
- Never invent routes or fields; if the pinned source does not show it, it is
  unsupported. Newer upstream docs do not describe v0.22.5. Parse every
  upstream shape in `wire.ts` so unknown keys (host paths, e-mail) are dropped.
- Canonical (session authority) and legacy sidecar protocols are separate code
  paths; never mix them on one connection.
- Answer approvals and clarify only with `request.answer` (`sendAnswer`),
  which Hermes acknowledges; never with a bare response frame.
- Never send anything for sudo, secret, vault or unknown requests: no error,
  no -32601, no empty value. Any reply settles them for every client and a
  credential prompt reads it as the answer. The 4404 vote is only for
  window-owned bridges on a sidecar that counts declines, never on a
  canonical socket (`rpc.ts` `unhandledRequestAction`).
- A prompt whose outcome is unknown is `uncertain` and never resent.
- Treat tickets, `hermes-gateway-ticket.*` subprotocols, tokens, cookies, codes,
  verifiers and display viewer ids as secrets: only `redact*` output may be
  logged.
- No telemetry, no external calls other than the configured Hermes origin.
- Tests run against the fake Hermes server (`@cindl/fixtures/fake-hermes`)
  whose frames are validated against the vendored schemas. A test that only
  checks a mock it wrote proves nothing. Drive interleavings and failures with
  the fake's own controls (`beforeHandle`, `afterHandle`, `respondError`,
  `failNext`, `frozen`, `dropConnections`, `appRequest` for app-level prompts,
  `stopScreen`/`startScreen`, `otherProfileDisplay` and `displayViewers` for
  the screen and its socket, whose input passes the ported `RfbClientFilter`;
  `store.serveAs` and `store.otherProfileScopes` for the served profile)
  rather than mocks.
