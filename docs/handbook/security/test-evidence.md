# Security test evidence

For each threat the acceptance matrix names under "Auth denial, origin/CSRF,
traversal, approval replay/expiry, reconnect, offline tests", the tests that
pin it on each surface, and the gaps. Tests are cited by file and title.

Everything here runs in unit tests, against the fake Hermes or in a browser
against the fake Hermes. Nothing is validated against a live Hermes (see the
matrix's live transport row), and no code coverage is measured.

## Auth denial

- **Cookie sign-in** (`packages/client-core/test/direct-cookie.test.ts`):
  - "signs out through /auth/logout, after which Hermes answers 401";
  - "keeps the session through a 401 that is not the gate ending it";
  - "keeps the session through a refusal that is not a 401, whatever it says";
  - "lets no 401 to an operation sent under an ended session end the next
    one".
- **Native sign-in** (`packages/hermes-adapter/test/native-auth.test.ts`):
  - "shares one refresh between concurrent 401s so a rotated token is never
    replayed";
  - "says the code expired when Hermes refuses it (its 400)".
- **A sign-in that a `stop()` withdraws** opens no browser, leaves no
  listener and saves nothing; one whose browser has answered still stands:
  - direct client (`packages/client-core/test/direct-client.test.ts`): "a
    stop() while the page is open cancels the leg and ends the sign-in at
    once", and at the boundary "a stop() after the browser answered lets the
    sign-in stand";
  - desktop (`apps/desktop/test/transport.test.ts`): "a stop() while the
    browser is open closes the loopback listener";
  - Android (`apps/android/test/loopback.test.ts`): "opens no browser, and
    writes no marker, when cancelled while its listener starts";
  - Android (`apps/android/test/direct.test.ts`), during the attempt-marker
    write: "a stop() then opens no browser, and leaves no listener or
    marker".
- **The owner's Cancel** withdraws a native sign-in the same way, without
  stopping the client (`packages/client-core/test/direct-client.test.ts`):
  - "without a session: a Cancel during B's status read opens none, and the
    link says why";
  - "a Cancel while the page is open cancels the leg and ends the sign-in at
    once";
  - "a Cancel after the browser answered: the sign-in still finishes and
    connects".
- **Android's Cancel sign-in** is that Cancel
  (`apps/android/test/direct.test.ts`): "a Cancel during B's status read
  opens no browser, starts no listener and saves nothing", and during the
  attempt-marker write "Cancel sign-in then opens no browser, and the
  sign-in fails as cancelled".
  Pressed with Sign in, before the client is called: "a Cancel pressed with
  Sign in, before the client is called, opens no browser and saves nothing
  (re-check PA1)"; after the browser answered: "a Cancel after the browser
  answered does not stop the sign-in: it finishes and is saved".
- **A sign-in that needs no browser,** because tokens for that Hermes are
  already stored, is withdrawn the same way
  (`packages/client-core/test/direct-client.test.ts`): "without a session: a
  Cancel during B's status read fails it as cancelled" and "without a
  session: a stop() during B's status read fails it as stopped".
- **Overtaken sign-ins** (`packages/client-core/test/direct-client.test.ts`):
  "with a session: a newer sign-in withdraws an older one as it starts,
  before its own reads" and "start() after a stop() withdraws a sign-in
  begun after that stop()".

## Origin and CSRF

- **Web** (`apps/web/test/same-origin-client.test.tsx`):
  - "never asks an origin Cindl does not accept for Hermes, even one that
    answers like Hermes";
  - "returns to the mount and the view only, never a query or another file".
- **Desktop:**
  - `apps/desktop/test/origin-policy.test.ts`: "reaches only the confirmed
    Hermes origin";
  - `apps/desktop/test/ipc.test.ts`: "refuses foreign senders before looking
    at the call";
  - `apps/desktop/test/websocket.test.ts`: "the screen socket does not follow
    a redirect".
- **Android** (`apps/android/test/direct.test.ts`): "refuses plain http to
  anything but this device".
- **Redirects** (`packages/hermes-adapter/test/login-page.test.ts`): "accepts
  a same-origin path outside the auth routes and /api";
  `packages/hermes-adapter/test/pkce.test.ts` takes only loopback redirect
  addresses.
- **Framing:** every answer of the web server carries `frame-ancestors
'none'` and `nosniff`, refusals included (`apps/web/test/serve.test.ts`,
  "never serves %s").
- **CSRF:** Cindl's part is that it sends nothing to an origin other than the
  Hermes it signed in to (above). How Hermes guards its own cookie-authenticated
  routes is Hermes's, and is not tested here.

## Traversal and paths

- **Web server** (`apps/web/test/serve.test.ts`): "never serves %s" covers
  `/cindl/../`, `%2e%2e`, `..%2F`, backslashes, `//`, symlinked and unlisted
  files.
- **Desktop:**
  - `apps/desktop/test/protocol.test.ts`: "refuses symlinks that resolve
    outside the root" and "checks containment by path, not by string prefix";
  - `apps/desktop/test/ipc.test.ts`: "saves under a sanitized base name";
  - `apps/desktop/test/loopback.test.ts`: "ignores other paths, methods, hosts
    and absolute-form targets".
- **Memory and documents** (`packages/client-core/test/direct-client.test.ts`):
  "refuses stale ids, text over the store limit, positional ids and
  unconfirmed changes".
- **REST path parameters** (`packages/hermes-adapter/test/rest.test.ts`): "sends
  no "." or ".." as a session id: nothing reaches Hermes", since URL
  normalization would route a dot segment elsewhere, and "still encodes and
  sends an id with dots among other characters". This is a second layer:
  Cindl's operations check their ids as `EntityId` and profile names as
  `ProfileName` before any handler runs, so neither reaches the REST client
  as a dot segment today.

## Approval replay and expiry

- **Adapter:**
  - `packages/hermes-adapter/test/server-requests.test.ts`: "reports an
    answer to a request that already ended as no longer pending";
  - `packages/hermes-adapter/test/connection.test.ts`: "refuses an expired
    ticket and keeps retrying with fresh ones" and "refuses a ticket that was
    already used, then recovers with a fresh one".
- **Direct client** (`packages/client-core/test/direct-client.test.ts`):
  - "answers an approval once with an offered choice; answered means sent";
  - "ties each answer outcome to the connection it was sent on (drop
    mid-answer, answer again)";
  - "keeps one answer when a history load re-lists the request while the
    answer is in flight".
- **Store** (`packages/client-core/test/state.test.ts`):
  - "ignores a stale frame from an older connection, so an acknowledged
    answer stays answered";
  - "does not let an older attempt's outcome close a request Hermes re-sent".
- **Web** (`apps/web/test/request-card.test.tsx`): "shows answers locked on
  another device and leaves them out of the reply".

## Reconnect

- **Direct client** (`packages/client-core/test/direct-client.test.ts`):
  - "reconnects with a fresh ticket, re-attaches and replays what it missed";
  - "reloads history instead of trusting replay after a Hermes restart";
  - "reloads history when the replay window was truncated";
  - "keeps every session and its requests when the socket drops while
    re-attaching (review H2)".
- **Web, in a browser** (`apps/web/e2e/live.spec.ts`): a dropped network makes
  the production build reconnect with a fresh ticket.
- **The screen:**
  - `packages/client-core/test/direct-client.test.ts`: "hands control back
    with the earlier viewer id, and never another viewer's lease";
  - `packages/client-core/test/rfb.test.ts`: "releases held keys and buttons
    when control is given up".

## Offline

- **Cookie sign-in** (`packages/client-core/test/direct-cookie.test.ts`):
  - "shows a 5xx on its own sign-in check as offline and asks again";
  - "keeps the link offline, not connecting, between attempts";
  - "asks again after no answer at all".
- **Direct client** (`packages/client-core/test/direct-client.test.ts`):
  - "goes offline on stop() and reconnects on start() (review M5)";
  - "sends offline prompts behind a running turn instead of redirecting it
    (review M4)";
  - "shows a secret store it cannot read as an error, not offline, and reads
    it again on start".
- **Web** (`apps/web/test/same-origin-client.test.tsx`): "stops waiting after
  the timeout and calls it no answer".

## Not covered here

- Anything against a live Hermes, including Hermes's own CSRF and session
  handling.
- The platforms' own rendering of an offline link: each reads the shared
  store, which the tests above cover.
