# 0005 Server requests answered once, conservative choices

**Status:** Accepted (contract v2; live validation pending)

**Context.** Hermes sends approvals and clarifications as server-to-client
JSON-RPC requests with ids of the form `srq-<12 hex>`
(`tui_gateway/server_requests.py` at v0.22.5). It broadcasts each request to
every attached client, re-sends it with the same id after a reconnect, accepts
an answer from any connection, and keeps the **first** reply. An error reply
closes the request for everyone; a "not shown" reply (code 4404) declines
without closing it until every client has declined. Approval choices upstream
are `once`, `session`, `always`, `deny`, with an optional `all` flag. A
clarify request holds 1-5 questions and expects one reply for the whole set.

**Decision.**

- Requests are identified by the Hermes request id, not by connection. A
  re-sent frame updates the same request; after a reconnect, requests Hermes no
  longer reports as open are closed as `resolved-elsewhere`.
- An approval is answered at most once with `once` or `deny`; standing grants
  and `all` are never sent, and the card says what was withheld. The buttons lock
  on the first click.
- A clarify set is answered in one submission covering every question (answered
  or skipped), or declined as a whole.
- Requests Cindl does not handle (secrets, sudo, vault, terminal or window
  reads, previews) are declined in the way that leaves them answerable by the
  owner's other Hermes clients (the not-shown reply where Hermes defines it).
  The exact reply per request kind is being verified against the pinned source;
  a blanket error reply is not acceptable because it would close the request
  for every client.

**Consequences.** Command approvals are presented as what they are, Hermes's
dangerous-command gate, not a universal spending or sending policy.
