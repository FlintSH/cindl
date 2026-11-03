# 0005 Server requests answered once, conservative choices

**Status:** Accepted (contract v4; answer path and live validation pending)

**Context.** Hermes sends approvals, clarifications and other prompts as
server-to-client JSON-RPC requests with ids of the form `srq-<12 hex>`
(`tui_gateway/server_requests.py` at v0.22.5). It broadcasts each request to
every attached client, re-sends only the requests it still holds open after a
reconnect, accepts an answer from any client and keeps the **first** one.
Approval choices upstream are `once`, `session`, `always` and `deny`, with an
optional `all` flag. A clarify request holds 1-5 questions and expects one
reply for the whole set.

Two facts shape the design:

- **Answers can be acknowledged.** A reply sent as a JSON-RPC response frame
  gets no acknowledgement, but the sidecar's `request.answer` method returns
  `ok` or `expired` (`tui_gateway/methods_prompt.py:1289-1302`), and the
  canonical `clarify.respond` and `approval.respond` return `resolved` or
  `already_resolved` (`contracts/canonical.py:356-364`). Acknowledgement means
  Hermes's registry accepted the answer. It does not mean the action that
  follows succeeded.
- **A decline can become a password.** If every answering client declines a
  sidecar request with 4404, the request settles at once with a non-empty JSON
  error string as its value (`server_requests.py:254-278`). The secret callback
  can store that string, and sudo and vault prompts use the value as the
  password or code (`agent_callbacks.py:250-280`). On the session-owner path,
  any error reply settles the request for every client.

**Decision.**

- Requests are identified by the Hermes request id, never by connection, and
  each belongs to one conversation (the frame's `session_id`).
- Cindl answers through a path Hermes acknowledges. A request is `answered`
  only when Hermes acknowledged this client's answer. Which acknowledged path
  and id format the adapter uses (sidecar `srq-…` or canonical `prompt_id`) is
  being settled against the pinned handlers. Until it is, nothing claims live
  answers work.
- An approval is answered at most once with `once` or `deny`. Standing grants
  and `all` are never sent, and the card says what was withheld.
- A clarify set is answered in one submission covering every question nobody
  else has answered (each answered or skipped). Answers another client locked
  are shown and never overridden. Declining a whole set stays in the contract
  only if the adapter shows it gives the agent a clean "declined" result.
- **Cindl never replies to sudo, secret or vault prompts, or to request kinds
  it does not know.** That rules out a 4404 decline, an error and an empty
  skip. They appear as `unsupported` requests, with a card that says what
  Hermes is waiting for and offers nothing to send. They stay open for another
  Hermes surface. An explicit skip may be reconsidered only after the per-kind
  behaviour is pinned by tests with synthetic callbacks. These prompts are
  never tested with real secrets.
- After a reconnect, a request Hermes re-sends reopens, whatever Cindl last
  knew about it. The client then syncs each conversation that has open
  requests and closes the rest as `resolved-elsewhere`.

The full lifecycle (statuses, events and what each implementation must emit)
is in the [server requests reference](../../reference/server-requests.md).

**Consequences.**

- Command approvals are presented as what they are, Hermes's dangerous-command
  gate. They are not a universal spending or sending policy.
- Cindl cannot unblock a sudo, secret or vault prompt. Hermes stays blocked
  until the owner answers it elsewhere, and Cindl shows that as waiting on
  the owner, outside Cindl.
