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

## Run the synthetic demo

```sh
pnpm install --frozen-lockfile
pnpm --filter @cindl/web dev:demo        # http://127.0.0.1:5173
```

Every name, message and status in the demo is invented (a fictional ceramics
studio). A banner at the top says so on every screen. The demo exercises the
real UI and client state code; it does not prove anything about a live Hermes.

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
- **Agent output is untrusted:** no raw HTML; remote images are not fetched
  until you choose **Load image**; links open in a new tab without referrer and
  show their destination; non-web link schemes are inert.
- **No tokens in the browser:** the web client relies on Hermes's HttpOnly
  session cookie. Only non-secret preferences (theme, working margin, pinned
  conversation) are stored locally.

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
CINDL_CAPTURE=1 pnpm test:e2e              # also capture the screenshot matrix
```

The flow tests fail on any console error, page error or CSP violation.
Screenshots go to the git-ignored `.agent-artifacts/web-qa/capture/`; review
them before publishing any.
