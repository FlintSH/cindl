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
recoverable backup (not yet established). `memory.text` is available only once
Hermes's learning routes answer. Cindl never uses generic filesystem routes for
memory or arbitrary paths.

Hermes renumbers memory entries when one is removed and gives them no other
identity, so a memory editor is bound to the entry it was opened for, by store
and text fingerprint, and locks (keeping the draft, saving and deleting
nothing) whenever its place shows other text. A draft reaches another entry
only through the owner's explicit choice, after that entry is read and found
still in place, and stays kept for the entry it was written for until it is
saved or discarded; another entry's own kept draft is only ever saved or
discarded by an action on that draft. A delete confirmation names the text read
under the id the delete sends (see the [web client page](../../clients/web.md)).
Entries with identical text in one store share one identity: Hermes resolves
either to the first, they share one kept draft, and an editor may follow
either. Kept drafts are forgotten whenever the session ends.

**Consequences.** Conflict detection narrows but cannot close a race window;
the UI and docs say so.
