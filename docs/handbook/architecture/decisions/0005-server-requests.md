# 0005 Server requests answered once, conservative choices

**Status:** Accepted

**Context.** Hermes sends approvals and clarifications as server-to-client
JSON-RPC requests. Approval choices upstream are `once`, `session`, `always`,
`deny`, with an optional `all` flag; `request.cancel` invalidates a question;
reconnect replay reports `open_requests`.

**Decision.** Cindl answers a request at most once, by its JSON-RPC id, on the
connection that received it, with an offered choice. From Cindl the only
approval choices are `once` and `deny`; standing grants and `all` are never
sent, and the card names what was withheld. Unimplemented server requests
(secrets, sudo, vault, terminal or window reads, previews) get `-32601`
immediately instead of hanging. The client keys requests by connection epoch so
a replayed frame cannot reopen an answered request.

**Consequences.** Command approvals are presented as what they are, Hermes's
dangerous-command gate, not a universal spending or sending policy.
