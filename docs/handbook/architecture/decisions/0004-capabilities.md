# 0004 Capability honesty

**Status:** Accepted

**Decision.** Every feature is gated on a `Capability` with a state
(`available`, `limited`, `unavailable`, `unsupported`, `unknown`), a reason and
its source (REST path or RPC method). Capabilities are negotiated per
connection; a missing entry means "not checked", never "working". The UI shows
unavailable features with their reason. Opening a page never triggers setup,
probes, guest-identity creation or host mutations.

**Consequences.** No fake connected states or placeholder counters. The
reference lists each capability's v0.22.5 source in
[capabilities](../../reference/capabilities.md).
