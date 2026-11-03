# 0006 Owner edits: diff, confirm, version check

**Status:** Accepted

**Context.** Hermes v0.22.5 exposes SOUL.md (`GET/PUT /api/profiles/{name}/soul`)
and skill content edits, without server-side compare-and-swap. `GET /api/memory`
returns metadata only. A generic filesystem read route exists but is a host
filesystem capability, not a memory API.

**Decision.** Edits go through edit → exact line diff → explicit confirmation.
Writes carry the SHA-256 of the version that was read (`expectedVersion`) and
`confirm: true`; the client re-reads and rejects the write on mismatch, and
keeps the previous text for restore on that screen. Memory text is
`unsupported` at v0.22.5. Cindl never uses generic filesystem routes for memory
or arbitrary paths.

**Consequences.** Conflict detection narrows but cannot close a race window;
the UI and docs say so.
