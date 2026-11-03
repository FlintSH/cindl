# packages/hermes-adapter

Everything Cindl knows about the Hermes wire protocol lives here. Read
`docs/handbook/reference/hermes-v0.22.5.md` and ADRs 0002, 0003 and 0005 first.

- Use only names in `src/upstream-surface.ts`. Adding one is a contract change:
  cite the upstream file at the pinned commit, regenerate
  `upstream/v0.22.5/contract-subset.json` with `scripts/extract-upstream.ts`,
  and update the reference page. Never hand-edit the vendored subset.
- Never invent routes or fields; if the pinned source does not show it, it is
  unsupported. Newer upstream docs do not describe v0.22.5.
- Canonical (session authority) and legacy sidecar protocols are separate code
  paths; never mix them on one connection.
- Treat tickets, `hermes-gateway-ticket.*` subprotocols, tokens, codes and
  verifiers as secrets: only `redact*` output may be logged.
- No telemetry, no external calls other than the configured Hermes origin.
- Tests run against a fake Hermes server whose frames are validated against the
  vendored schemas. A test that only checks a mock it wrote proves nothing.
