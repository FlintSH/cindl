# 0006 Owner edits: diff, confirm, version check

**Status:** Accepted

**Context.** Hermes v0.22.5 exposes SOUL.md (`GET/PUT /api/profiles/{name}/soul`)
and skill content edits, without server-side compare-and-swap. `GET /api/memory`
returns provider metadata only. Memory entries are a separate surface:
`GET /api/learning/graph` and `GET/PUT/DELETE /api/learning/node` address
entries by fingerprinted id (`memory:<source>:<index>:<fingerprint>`), re-resolve
them under Hermes's memory lock and refuse stale ids. A generic filesystem read
route also exists; it is a host filesystem capability, not a memory API.

**Decision.** Edits go through edit → exact line diff → explicit confirmation.
Writes carry the SHA-256 of the version that was read (`expectedVersion`) and
`confirm: true`; the client re-reads and rejects the write on mismatch, and
keeps the previous text for restore on that screen. Memory entries will be
edited only through the fingerprinted learning-node API, with the exact id that
was read; positional or unfingerprinted ids are refused for writes, memory reset
is never a substitute, and undo is promised only where Hermes keeps a
recoverable backup (not yet established). Until that support is implemented and
tested, `memory.text` is unsupported in Cindl. Cindl never uses generic
filesystem routes for memory or arbitrary paths.

**Consequences.** Conflict detection narrows but cannot close a race window;
the UI and docs say so.
