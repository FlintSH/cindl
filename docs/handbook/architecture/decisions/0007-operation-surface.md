# 0007 Narrow operation surface, no passthrough

**Status:** Accepted

**Decision.** UI code calls only `clientOps` (`packages/contracts/src/ops.ts`):
named operations with Zod-validated arguments and results. There is no generic
RPC or REST call from UI code. On Electron the main process re-validates every
call from the renderer, so a compromised renderer cannot reach Hermes methods
such as `shell.exec`, `cli.exec` or `vault.*`. Implementations emit the events
implied by an operation's result so every store converges.

**Consequences.** Adding a Hermes feature means adding an operation through the
contract-change protocol.
