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
  canonical `clarify.respond` (`tui_gateway/contracts/canonical.py:356-369`)
  and `approval.respond` (`tui_gateway/contracts/canonical_sessions.py:286-288,
328`) return `resolved` or `already_resolved`
  (`gateway/session_pending_controls.py:65-101`). Acknowledgement means
  Hermes's registry accepted the answer. It does not mean the action that
  follows succeeded.
- **A decline can become a password.** If every answering client declines a
  sidecar request with 4404, the request settles at once with a non-empty JSON
  error string as its value (`server_requests.py:254-278`). The secret callback
  can store that string (`tui_gateway/agent_callbacks.py:231-254`), and sudo
  and vault prompts use the value as the password or code (`:256-257`,
  `:265-279`; the value comes back from `tui_gateway/server.py:1092-1097`). On
  the session-owner path, any error reply settles the request for every client
  (`gateway/session_server_requests.py:74-93`).

**Decision.**

- Requests are identified by the Hermes request id, never by connection.
  Approvals and questions belong to one conversation (the frame's
  `session_id`); only an app-level prompt Cindl never answers may have none
  (`display.install.sudo` arrives with an empty `session_id`).
- Cindl answers through the sidecar's acknowledged
  `request.answer {id: srq-…, result}`. A standalone `hermes serve` has no
  session authority (`tui_gateway/ws.py:357-379`), so the canonical respond
  verbs are not on Cindl's allowlist. A request is `answered` only when Hermes
  acknowledged this client's answer. Live validation of this path is still
  pending.
- An approval is answered at most once with `once` or `deny`. Standing grants
  and `all` are never sent, and the card says what was withheld.
- A clarify set is answered in one submission covering every question nobody
  else has answered (each answered or skipped). Answers another client locked
  are shown and never overridden. There is no decline: an empty reply reaches
  the agent as `outcome: "cancelled"`, exactly like an interrupt
  (`tools/clarify_batch.py:15-31`), so "Skip all" answers every open question
  as skipped instead.
- **Cindl never replies to sudo, secret or vault prompts, or to request kinds
  it does not know.** That rules out a 4404 decline, an error and an empty
  skip. They appear as `unsupported` requests, with a card that says what
  Hermes is waiting for and offers nothing to send. They stay open for another
  Hermes surface. An explicit skip may be reconsidered only after the per-kind
  behaviour is pinned by tests with synthetic callbacks. These prompts are
  never tested with real secrets.
- The one reply Cindl sends without answering is the 4404 "not shown" vote
  for a prompt that another app's window owns, and only on a sidecar socket
  that counts such votes (`declines_not_shown`, `server_requests.py:117-121`).
  Never on a canonical socket, where any error reply settles the request.
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
- Staying silent has a cost where Cindl cannot vote: a prompt another app's
  window owns (`window.read`, `terminal.read`, `preview.*`, `tour`,
  `theme.apply`) settles only when every client that answers server requests
  declines (`tui_gateway/server_requests.py:264-273`). If Cindl is attached on
  a socket that does not count votes, the agent waits out the prompt's
  deadline (30 s for `window.read`, `tui_gateway/agent_callbacks.py:176`) and
  gets an empty answer instead of "no window shows this chat". These kinds are
  candidates for a per-kind rule once it is pinned by tests.
