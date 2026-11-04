# Web client

The web client is the responsive Cindl interface for browsers. The same build
is the renderer of the desktop app.

## What it needs to reach Hermes

Hermes v0.22.5 accepts browser requests only from the `hermes serve` origin:
its Origin, Host and CORS checks stay as they are, and Cindl does not ask for
wildcard CORS. The web client therefore reaches a live Hermes only when it is
served from that same origin, under a sub-path such as `/cindl/`, and signed
in through Hermes's own `/login` page.

### Served from the Hermes origin

- **How it decides.** At start, a production build asks its own origin's
  public `GET /api/status` (the client asks again as it connects). While it
  waits, the page says it is looking for Hermes. Then:
  - a Hermes answer offering the `cookie` sign-in flow, on an origin Cindl
    accepts for Hermes (https, or plain http on 127.0.0.1 or [::1]): it talks
    to Hermes;
  - a 404, a page or another server: **"Cindl is not connected"**, because the
    page is not served from a Hermes origin;
  - no answer within 5 seconds, a network error or a 5xx (Hermes restarting):
    **"Hermes did not answer"**, with "Try again";
  - Hermes without the browser sign-in (loopback-token mode, or still
    starting): **"Hermes offers no sign-in for browsers"**, with "Try again";
  - plain http away from this machine: not connected, and it never asks.
    It never shows demo data in any of these.
- **Signing in.** "Sign in on Hermes" opens Hermes's own sign-in page. Its
  `next` is the mount (such as `/cindl/`) and the view you were on, never a
  query, escaped so you come back to the same view. Hermes decodes it once
  more with an OAuth provider than with its password sign-in, so a view whose
  address holds an escape (`%`), such as a skill named `tools/git`, brings you
  back to the mount instead. Cindl never sees the password: the session is
  Hermes's HttpOnly cookie, which the page cannot read. "Check again" asks
  Hermes whether this browser is signed in now.
- **Talking to Hermes.** Every request goes to the page's own origin with the
  browser's cookie. Each connection (and each reconnect) gets a fresh
  single-use ticket from `POST /api/auth/ws-ticket` and opens `/api/ws` with
  it as a subprotocol; the agent's screen opens `/api/display/ws` with its own
  display ticket. Hermes must be at the root of the origin: Cindl does not
  follow a proxy prefix.
- **What it keeps.** Nothing in browser storage except the theme and margin
  preferences. Its device state (messages waiting to send, which sent messages
  Hermes accepted, how many times it has connected, and which conversation is
  the main one) lives in memory for the tab, so a reload starts from what
  Hermes holds.
- **Signing out.** "Sign out on this device" asks Hermes (`POST /auth/logout`)
  to clear its session cookie in this browser. What Hermes v0.22.5 ends on its
  side depends on how it signs you in: its basic and Nous sign-ins revoke
  nothing, so a copy of the cookie keeps working until it expires (with basic,
  12 hours for access and 30 days for refresh); its self-hosted OIDC sign-in
  asks the identity provider to revoke the refresh token when that provider
  supports it, and the access token Hermes already set still works until it
  expires. When Hermes
  ends the session itself (its gate answers that the session is over), Cindl
  stops and shows sign-in.
  - Other Cindl tabs in this browser follow at once: the tab that signed out
    tells them (a `BroadcastChannel`), and each asks Hermes whether its
    session still works, as it also does on becoming visible again and every
    15 seconds while open (browsers slow that in a hidden tab, and the check
    on becoming visible covers the return). Those whose session is gone show
    sign-in.
  - Hermes confirms a sign-out when, after it, it no longer accepts this
    browser's session. If it does not, Cindl signs out here and says so, and
    the sign-in screen offers "Sign out on Hermes" until Hermes confirms it.
  - An open Cindl tab keeps its session from lapsing: its 15-second check is
    a request like any other, so once the access cookie expires the gate
    renews the cookies through the refresh cookie. Closing the tabs only
    stops that; the cookies keep signing this browser in until they expire.
    Only signing out clears them here.
- **Browsers.** Tested in Chrome only; Safari and Firefox are untested. The
  page's own policy allows same-origin WebSockets (`connect-src 'self'`);
  WebKit fixed that case in 2022 (bug 235873), and older Safari blocks them.
- **What the mount must do.** Serve the build's files under the sub-path with
  their content types (`.js` as a JavaScript type such as `text/javascript`,
  which browsers require for module scripts), redirect the bare sub-path (`/cindl`) to the one with a
  trailing slash (the build's asset paths are relative), send
  `Content-Security-Policy: frame-ancestors 'none'` with Cindl's pages and
  `Cache-Control: no-cache` with `/cindl/` and `index.html`, and pass every
  other path to Hermes unchanged. Cindl uses hash routes, so no other path
  needs rewriting. Pages on one origin share cookies and storage, so serve
  nothing there that you do not trust as you trust Hermes. A front that cannot
  set headers can proxy to Cindl's own loopback server,
  `apps/web/serve/cindl-serve.py`, which sends `frame-ancestors 'none'` with
  every answer, its own errors included, and `no-cache` with the page
  ([Running Cindl](../operations/index.md#if-the-front-cannot-set-headers)).

Opened anywhere else, the production build says it is not connected,
explains why, and points to the desktop and Android apps. Developers use the
**synthetic demo** (below).

## Inside the desktop app

The desktop app loads this same build, which then talks to the desktop main
process instead of Hermes directly:

- With no Hermes session, the renderer shows a sign-in screen that asks only
  for the Hermes address (https, or plain http on 127.0.0.1 or [::1]). Hermes's
  own sign-in page opens in the system browser, so Cindl never handles a
  password or a verification code. If the browser never comes back, "Stop
  waiting" frees the screen; it does not cancel the sign-in in the browser.
  From then on the abandoned sign-in can no longer report an error or unlock
  the screen.
- Notices from the desktop app (for example, that tokens are kept in memory
  only on this machine) appear above the current view until dismissed. They sit
  in the page flow, so they never cover a control.
- Errors cross the desktop bridge as plain objects and are turned back into
  `CindlError` values with their stable code. A plain object that is not a
  Cindl error becomes an `internal` error rather than an unexplained failure;
  an `Error` passes through unchanged.

## Run the synthetic demo

```sh
pnpm install --frozen-lockfile
pnpm --filter @cindl/web dev:demo        # http://127.0.0.1:5173
```

Every name, message and status in the demo is invented (a fictional ceramics
studio). A banner at the top says so on every screen. The demo exercises the
real UI and client state code; it does not prove anything about a live Hermes.

## What it looks like

Screenshots of the synthetic demo (every name, message and status is
invented; the banner says so), and of the desktop app's signed-out screen,
which has no data to label.

![Talk on a wide screen: an approval and a question set waiting, with the working margin listing both](/screenshots/web/talk-desktop-light.png)

![Work on a phone in the dark theme: a sudo prompt Cindl does not answer, above an approval](/screenshots/web/work-phone-dark.png)

![Library, Memory: an agent note open in the reviewed-diff editor](/screenshots/web/memory-entry-light.png)

![Deleting a memory entry on a phone: Cindl warns that Hermes keeps no backup](/screenshots/web/memory-delete-phone-dark.png)

![The desktop app's sign-in screen, which asks only for the Hermes address](/screenshots/web/desktop-sign-in-light.png)

## Build

```sh
pnpm --filter @cindl/web build            # production build, no demo data
pnpm --filter @cindl/web build:demo       # labelled demo build in dist-demo
```

Builds use relative asset paths, so the same output loads under a sub-path or
from the desktop app's custom protocol.

## Security properties

- **Content-Security-Policy** in production builds: no remote scripts, styles,
  fonts or images; `connect-src 'self'`.
- **Agent output is untrusted:** no raw HTML; images in messages are never
  loaded (remote, relative or inline), and Cindl names what it withheld; every
  link shows its destination host next to its text and opens in a new tab
  without referrer; non-web link schemes are inert.
- **Not framable:** a meta-tag policy cannot stop framing, so a same-origin
  mount must send `Content-Security-Policy: frame-ancestors 'none'` (or
  `X-Frame-Options: DENY`) for Cindl's pages; otherwise a page elsewhere could
  frame the decision cards.
- **No tokens in the browser:** the web client relies on Hermes's HttpOnly
  session cookie. Only non-secret preferences (theme and whether the working
  margin is open) are stored locally.
- **Prompts Cindl never answers:** when Hermes asks for a sudo password, a
  secret value or a vault code, Cindl shows a read-only "Answer outside Cindl"
  card and sends nothing back, not even a decline, because any reply could
  become the password Hermes uses. Answer it in another Hermes surface, such as
  the Hermes terminal; it stays open until Hermes closes it. Prompts that
  belong to no conversation, such as the sudo prompt of a screen install
  started in another Hermes app, appear while Hermes lists them and point you
  to the app that started the operation, the only place Hermes asks.
- **The agent's screen:** Work > Computer shows the agent-owned screen live
  when Hermes's screen is running and the client supports the picture (the
  labelled demo streams a synthetic one). Watching sends no input. After "Take
  control" the screen takes pointer and keyboard input; Tab is never
  forwarded, so focus can always leave it. Input is never logged. Leaving the
  screen closes its view, even one still opening. While the view is open,
  Hermes counts the screen as in use, so its idle stop waits. Cindl never
  starts, stops or installs the screen.
- **Memory edits are explicit:** each entry changes only after you review a
  diff and confirm, and only if it has not changed in Hermes since you read it.
  An editor is bound to the entry you opened, by its text, from the moment you
  open it. It follows the entry when only its number changes (an entry in the
  other store was removed). Any other text at its place, even before the first
  read arrives, may be the same entry changed elsewhere, or another entry
  removed, merged or added there, and Hermes's list cannot tell which. So the
  editor locks, keeps your text read-only, names the entry now at its place,
  and saves or deletes nothing. When an entry before it in the same store was
  removed, the entry moved up a place: the locked editor says where the same
  text is now (its row reads "No longer at this place" when nothing took its
  place), and the entry's own draft comes back when you open it there (the
  lock says where any other text goes). A locked editor can reload the list.
  - "Use this draft for the entry now here" reads that entry first. Nothing
    changes unless the read succeeds and the entry is still at that place; a
    failed read is shown, and you can try again. If the entry changed again,
    Cindl fetches the list, so the next try uses the entry now there. Then you
    review the draft against that entry's text before saving.
  - A draft stays kept for the entry it was written for until you save or
    discard that draft, including while you edit it for another entry. So
    closing the editor loses nothing: the draft goes back to that entry while
    Hermes lists it, and otherwise waits under "Unsaved drafts". It never
    follows the entry you used it for.
  - An entry's own kept draft is never replaced or forgotten by other text,
    and it is the one that returns when you open the entry. When the editor
    shows the entry without it, the draft is offered (Continue the draft,
    Discard the draft). Editing afresh, saving or discarding that fresh text
    leaves it; if the fresh text must be kept too, it is kept beside it and
    waits under "Unsaved drafts", which names the entry it was written for.
    Drafts for entries Hermes no longer lists stay there too, to copy or
    discard. Each discard button names its draft by its first line, numbered
    when two drafts share one.
  - When a locked editor's entry has moved, the lock says where the text you
    were editing goes when you close it: back with the entry, back to the
    entry it was written for, or under "Unsaved drafts".
  - A delete names the text it removes: the first line with words in it, of
    the text Cindl read under the id the delete sends. Deleting warns first,
    because Hermes keeps no backup.
  - Focus never drops to the page because of a change in an editor (memory
    entries, SOUL and skills alike). When the control you were on goes or is
    disabled (a step, a save or an adoption under way, a lock, Continue or a
    discard), focus moves to what took its place: the lock notice while the
    editor is locked, else your draft, the changes under review, or Edit. A
    completed adoption puts focus in your draft. Deleting moves focus to
    "Keep it", back to "Delete entry…" if you keep the entry, and to the
    Entries heading once it is gone. Focus you moved elsewhere, even to plain
    page text, stays there. The adopt button is described by the entry now at
    the place. A real browser checks these, because a browser drops focus
    from a disabled control a frame later and jsdom does not.
  - An entry whose first line is only a heading mark gets no title from
    Hermes; Cindl names it by its first line with words, in its row and the
    lock notice, or by its place (for example "agent note 3") when it has
    none.
  - Discarding a draft Hermes refused as stale clears that refusal; saving
    the next draft against a version Hermes has replaced is refused again.
  - After a save, the text it replaced stays on screen: ready to restore while
    the entry is still the one you saved, and otherwise only to copy.
  - Known limit: entries with identical text in one store look the same to
    Cindl, so they share one kept draft, and an editor may follow either.
- **Drafts stay on this device, briefly:** answers being written, and document
  drafts kept after a save conflict, a lock or while used for another memory
  entry, live in memory only. An answer's draft is dropped once its request
  closes, and every draft is forgotten when the session ends, whether you sign
  out or Hermes refuses the session.

## Keyboard

| Keys                    | Action                             |
| ----------------------- | ---------------------------------- |
| `Ctrl/⌘ K`              | Open the command palette           |
| `Ctrl/⌘ J`              | Switch conversation                |
| `Ctrl/⌘ Shift O`        | Start a side conversation          |
| `Ctrl/⌘ .`              | Show or hide the working margin    |
| `Alt 1` to `Alt 4`      | Go to Talk, Work, Library, Agent   |
| `/`                     | Focus the message box              |
| `?`                     | Show keyboard shortcuts            |
| `Enter` / `Shift Enter` | Send / new line in the message box |

## Tests

```sh
pnpm test                                  # includes web component tests
pnpm test:e2e                              # Playwright flows on the demo build
CINDL_E2E_CHANNEL=chrome pnpm test:e2e     # use an installed Chrome
CINDL_E2E_PORT=4291 pnpm test:e2e          # when another checkout holds 4173
CINDL_CAPTURE=1 pnpm test:e2e              # also capture the screenshot matrix
```

`e2e/live.spec.ts` builds the production web client (no demo data) and serves
it at `/cindl/` on one loopback origin with a fake Hermes (test-only,
synthetic; everything outside `/cindl/` goes to the fake, sockets included).
In a real browser it signs in through the fake's stand-in for Hermes's login
page and comes back, starts a conversation, answers an approval once,
reconnects with a fresh ticket after the network drops, reloads into a deep
link, watches and controls the synthetic screen, and signs out through Hermes.
It also checks that nothing leaves the origin and nothing lands in browser
storage. It is not proof against a real Hermes.

The flow tests fail on any console error, page error or CSP violation.
Screenshots go to the git-ignored `.agent-artifacts/web-qa/capture/`; review
them before publishing any.
