# Server requests

How a Hermes server request (an approval, a clarify set or a prompt Cindl does
not answer) moves through Cindl, for contract v4. The schemas are in
`packages/contracts/src/domain.ts` (`ServerRequest`) and `events.ts`; the
reducer that applies them is `packages/client-core/src/state.ts`. Why it works
this way is in [ADR 0005](../architecture/decisions/0005-server-requests.md).

## Kinds

| Kind          | What it is                                                                                                                                                                                                                                    | Cindl can answer                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `approval`    | Hermes's dangerous-command gate                                                                                                                                                                                                               | `once` or `deny`, if Hermes offered them                                  |
| `clarify`     | 1-5 questions answered together                                                                                                                                                                                                               | One submission covering every open question                               |
| `unsupported` | sudo, secret and vault prompts (`unsupportedKind`), other prompts Cindl does not answer (`theme.pick`, `setup_beat`) and kinds it does not know. An app-level one (such as `display.install.sudo`) has no conversation and shows only in Work | Never. Nothing is sent, not even a decline (it could become the password) |

## Statuses

| Status               | Meaning                                                                                        | Reached by                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`               | Hermes is waiting                                                                              | `request.opened`; a failed answer; a re-send on a newer connection                                                                                                                                                   |
| `answering`          | This client's answer is on its way                                                             | The implementation re-emits the request with this status and the answer before sending it                                                                                                                            |
| `answered`           | Hermes acknowledged that it accepted this client's answer. The resulting action may still fail | `request.closed` `answered`, emitted only on an acknowledgement                                                                                                                                                      |
| `resolved-elsewhere` | Closed without an acknowledged answer from this client                                         | A "resolved" cancel from Hermes (on the sidecar only when an approval was resolved from another surface; on the owner path after any viewer answers), an `expired`/`already_resolved` reply, or a sync that omits it |
| `cancelled`          | Hermes withdrew it (for example, the turn was interrupted)                                     | `request.closed` `cancelled`                                                                                                                                                                                         |
| `expired`            | It timed out in Hermes                                                                         | `request.closed` `expired`                                                                                                                                                                                           |

A closed request keeps the answer this client sent, so the UI can say what was
sent even when Hermes cannot say whose answer it used. There is no terminal
failure state: a failed send returns the request to `open`.

## Events

- `request.opened`: Hermes holds the request open. It comes from a live request
  frame or from Hermes's open-requests list after a reconnect, never from
  history replay. Connection epochs only move forward: a frame with a lower
  `lastSeenEpoch` than the request already has is stale and changes nothing.
  On the same connection it never reopens a closed request and keeps an answer
  that is in flight. A re-send on a newer connection (higher `lastSeenEpoch`)
  reopens the request whatever this client knew, because Hermes re-sends only
  requests it still holds open.
- `request.closed`: the request is no longer open, with Hermes's status. When
  the close is the outcome of this client's attempt it carries that attempt's
  `connectionEpoch`, and an `answered` close carries the `answer` Hermes
  acknowledged. That answer is recorded even if a later attempt is in flight,
  because Hermes keeps the first answer it accepted, and an `answered`
  acknowledgement that arrives after a `resolved-elsewhere` close still
  records `answered`. Any other outcome of an attempt from an older connection
  is ignored once Hermes has re-sent the request.
- `request.answer-failed`: the answer did not reach Hermes, or Hermes rejected
  it and still holds the request open. The request is answerable again. With
  a `connectionEpoch`, it applies only to the attempt in flight on that
  epoch, so a late failure of an older attempt cannot unlock a newer one.
- `requests.synced`: after a reconnect, one per conversation that has open
  requests, listing what Hermes still holds there. That conversation's other
  open or answering requests close as `resolved-elsewhere`. Other
  conversations are untouched. Implementations may also send it while
  requests are open: the direct client checks every 15 s, because the sidecar
  tells other clients nothing when one answers by frame. With a
  `connectionEpoch`, a list from an older connection cannot close a request
  seen on a newer one.

Related: `prompt.removed` drops a queued or uncertain local prompt record (a
message, not a server request) after it was dismissed or delivered.

## What every implementation must do

The adapter, the desktop main process and the Android client all produce
these events.

1. Validate `request.answer` arguments with `parseOpArgs`. Failures are
   `CindlError` `invalid` with a message that starts `Not sent:`.
2. Call `assertAnswerable` (from `@cindl/contracts`) before sending: it
   rejects `unsupported` requests with `CindlError` `unsupported`. Never send
   Hermes anything for them. The schema gives them no choices or questions,
   and the reducer never shows one as `answering`.
3. Before sending an answer, emit `request.opened` with status `answering`,
   the answer and `lastSeenEpoch` set to the epoch it is sent on.
4. End `answering` with exactly one of: `request.closed` `answered` (Hermes
   acknowledged), `request.closed` `resolved-elsewhere` (Hermes says it was no
   longer pending), or `request.answer-failed`. Give each the attempt's
   `connectionEpoch`, and give `answered` the `answer` Hermes acknowledged.
5. After every reconnect, emit `requests.synced` for each conversation with
   open requests on either side.

## Clarify sets

- Question ids are Hermes's `q<index>` (`tools/clarify_tool.py`). An id of
  `__proto__` is refused: a record keyed by it silently loses the key.
- `lockedAnswers` are answers other clients locked (`clarify.lock`). Cindl
  shows them and leaves those questions out of its reply. It only knows the
  locks Hermes has sent, so a lock made since the last snapshot can be
  missing, and then Cindl's reply overrides it: Hermes lays the reply over the
  locks (`tools/clarify_batch.py:27-31`). On the sidecar, the last lock settles
  the request without an event; Cindl learns that from the open-requests
  check.
- The reply must cover exactly the open questions, each answered (`choices` or
  `text`) or skipped. `clarifyAnswersComplete` checks this. There is no
  decline: an empty reply reaches the agent like an interrupt, so "Skip all"
  skips every open question.
- Limits: a choice can be up to 16,384 UTF-16 units, so every choice Hermes
  offers is sendable (Hermes allows 8,000 code points plus a " (Recommended)"
  suffix, and an astral character takes two units); typed text up to 20,000.
  Locked answers from Hermes are accepted at any length.

## In the UI

- The decision card locks while the answer call runs, shows "Sending your
  answer…" while the request is `answering`, and is usable again after
  `request.answer-failed`.
- A question card offers "Skip all", which skips every open question; there
  is no "decline" button.
- An `unsupported` request gets a read-only card ("Answer outside Cindl") that
  says what Hermes is waiting for. It counts as waiting on the owner in the
  presence line, Work's "Needs you" list and the navigation count.
