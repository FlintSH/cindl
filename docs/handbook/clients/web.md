# Web client

The web client is the responsive Cindl interface for browsers. The same build
is the renderer of the desktop app.

## What it needs to reach Hermes

Hermes v0.22.5 accepts browser requests only from the `hermes serve` origin:
its Origin, Host and CORS checks stay as they are, and Cindl does not ask for
wildcard CORS. The web client therefore works against a live Hermes only when it
is served from that same origin and signed in through Hermes's own `/login`
page. That mount is a pending owner decision, so today:

- A production build opened anywhere else shows **"Cindl is not connected"**,
  explains why, and points to the desktop and Android apps. It never shows demo
  data in that state.
- Developers use the **synthetic demo** (below).

## Inside the desktop app

The desktop app loads this same build, which then talks to the desktop main
process instead of Hermes directly:

- With no Hermes session, the renderer shows a sign-in screen that asks only
  for the Hermes address (https, or plain http on 127.0.0.1 or [::1]). Hermes's
  own sign-in page opens in the system browser, so Cindl never handles a
  password or a verification code. If the browser never comes back, "Stop
  waiting" frees the screen; it does not cancel the sign-in in the browser.
  Once you start another sign-in, the abandoned one can no longer report an
  error or unlock the screen.
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
invented; the banner says so).

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
  the Hermes terminal; it stays open until Hermes closes it. A prompt that
  belongs to no conversation (Hermes sends those only to the connection that
  started the operation) says so instead, and closes when Hermes stops waiting
  or Cindl reconnects.
- **Memory edits are explicit:** each entry changes only after you review a
  diff and confirm, and only if it has not changed in Hermes since you read it.
  After a save, the previous text stays on screen, ready to restore, until you
  leave the entry. Deleting an entry warns first, because Hermes keeps no
  backup.
- **Drafts stay on this device, briefly:** answers being written and document
  edits kept after a save conflict live in memory only. An answer's draft is
  dropped once its request closes, and every draft is forgotten on sign-out.

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

The flow tests fail on any console error, page error or CSP violation.
Screenshots go to the git-ignored `.agent-artifacts/web-qa/capture/`; review
them before publishing any.
