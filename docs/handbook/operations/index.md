# Running Cindl

**There is no deployment of Cindl yet.** Cindl is pre-release: nothing in this
repository is published, packaged for installation or validated against a live
Hermes. This page states what an operator will run, what exists today, and
which decisions block the rest.

There is no Cindl server to operate. Each client talks directly to an
existing, authenticated Hermes `hermes serve` backend
([ADR 0002](../architecture/decisions/0002-direct-hermes-transport.md)).

## How each client will reach Hermes

| Client  | Connection                                                                                                                                                                 | State today                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web     | Served from the same origin as `hermes serve` and signed in with Hermes's own session cookie. No tokens in the browser.                                                    | Connects when served under a sub-path such as `/cindl/` of the Hermes origin: signs in through Hermes's own page, chats, answers approvals once, reconnects, shows the agent's screen and signs out through Hermes, all tested in a real browser against a fake Hermes. The owner approved a private mount at `/cindl/` on their Hermes ([decision](../project/pending-decisions.md#same-origin-web-mount)). Opened anywhere else, it says it is not connected and shows no data. |
| Desktop | The Electron main process connects to the `hermes serve` origin you sign in to, using Hermes's native PKCE flow with a loopback redirect. Tokens stay in the main process. | Linux x64 AppImages (unsigned; real and labelled demo) built and smoke-tested by `desktop.yml`. Not yet run against a live Hermes.                                                                                                                                                                                                                                                                                                                                                |
| Android | The app connects to the `hermes serve` origin directly and signs in with the same native flow through the system browser. Tokens stay in Keystore-backed storage.          | Test APKs (labelled demo and production, signed with a throwaway key for each run) built by `android.yml` and exercised on an emulator against a fake Hermes. Not yet run against a live Hermes or on a phone.                                                                                                                                                                                                                                                                    |

Desktop and Android sign in only to an `https://` origin; plain `http://` is
accepted only for a Hermes on the same machine (`127.0.0.1` or `[::1]`). The
origin is the scheme, host and port alone: no credentials, path or query. The
authentication design is in
[ADR 0003](../architecture/decisions/0003-authentication.md) and the exact
routes in the [Hermes v0.22.5 reference](../reference/hermes-v0.22.5.md).

## What the operator keeps as it is

- **Hermes v0.22.5**, the verified baseline. Other versions are untested: the
  clients enable only what they can negotiate and say so.
- **`hermes serve` as already configured.** Cindl uses its existing REST and
  WebSocket transport. Hermes's dedicated API server and webhooks stay
  disabled; Cindl never asks for them.
- **The network as it is.** Cindl adds no public listener, tunnel, DNS record
  or change to the Hermes service. How a phone or laptop reaches `hermes serve`
  away from home is the operator's existing setup.
- **No keys to manage.** Cindl has no model, no API keys and no account of its
  own. Signing out of a native client forgets that device's tokens, and the
  web client asks Hermes to clear its cookie in that browser. What Hermes
  v0.22.5 revokes depends on its sign-in provider: basic and Nous revoke
  nothing, so copies keep working until they expire, and self-hosted OIDC
  revokes only the refresh token.

## What runs today

| What                             | How                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The web client on synthetic data | `pnpm --filter @cindl/web dev:demo`, on `127.0.0.1` only, always bannered as a demo ([Getting started](../development/getting-started.md)) |
| The production web bundle        | `pnpm --filter @cindl/web build`; checked in CI for synthetic fixture records and local paths; served by the operator (below)              |
| This handbook                    | Built in CI and uploaded as a workflow artifact for review; not hosted                                                                     |

## Serve the web client from the Hermes origin

The web client must come from the same origin as `hermes serve`, because it
signs in with Hermes's own session cookie. Usually that is the reverse proxy
that already terminates HTTPS for Hermes:

1. Build it: `pnpm install --frozen-lockfile`, then
   `pnpm --filter @cindl/web build`. The files are in `apps/web/dist`. The
   build holds no address: it finds Hermes at the origin that serves it.
2. Serve `apps/web/dist` at `/cindl/` (another sub-path works too):
   `index.html` for `/cindl/`, each file under it with its content type, and
   a redirect from `/cindl` to `/cindl/`. The types: `.html` `text/html`,
   `.js` a JavaScript type such as `text/javascript` (browsers refuse module
   scripts of any other type),
   `.css` `text/css`, `.svg` `image/svg+xml`, `.woff2` `font/woff2` and
   `.map` `application/json`.
3. Send `Content-Security-Policy: frame-ancestors 'none'` with those
   responses (the page's own policy is a meta tag, which cannot forbid
   framing), and `Cache-Control: no-cache` with `/cindl/` and
   `/cindl/index.html`, so a browser never pairs an old page with files a
   newer build replaced. The other files' names change with their content, so
   they may be cached.
4. Pass every other path to `hermes serve` unchanged, WebSocket upgrades
   included. Hermes stays at the root of the origin: Cindl does not follow a
   proxy prefix. Nothing about Hermes changes.
5. Open `/cindl/` on the Hermes origin and choose "Sign in on Hermes".

Pages on one origin share cookies and storage with each other, Hermes's own
app included, so serve nothing else on that origin that you do not trust as
you trust Hermes.

### If the front cannot set headers

Some fronts only proxy a path to another server; Tailscale Serve is one. Run
Cindl's own small server on loopback and point the front's path at it:

```sh
python3 apps/web/serve/cindl-serve.py --root apps/web/dist --port 8099
```

It needs only Python 3, listens on loopback only and serves just the build's
regular files, read once at start: no symlinks, no directory listings and
nothing outside the build. It sends the headers above (`frame-ancestors
'none'`, `nosniff`, `no-cache` for the page and other unhashed files, long
caching for hashed assets) and the content types the build needs. It ignores
request headers, cookies included, and logs only the request line. It takes
the mount path as is (`/cindl/assets/...`) or with the front's mount stripped
(`/assets/...`).

A front that strips the mount, as Tailscale Serve does, never shows the server
the bare `/cindl`, and Tailscale Serve does not redirect it to `/cindl/`
either. If the front can map that exact path, map it to the server's
`/.cindl-bare`, which redirects to `/cindl/`. With Tailscale Serve that would
be `/cindl/` mounted at `http://127.0.0.1:8099` and `/cindl` at
`http://127.0.0.1:8099/.cindl-bare`; check it with the first two checks below.
Otherwise always open `/cindl/` with the slash: at `/cindl` the page's
relative asset paths miss.

Checks that need no sign-in, after mounting:

- `/cindl/` answers 200 with `text/html`, the `frame-ancestors 'none'` policy
  and `Cache-Control: no-cache`; its body matches the build's `index.html`.
- `/cindl` redirects (301 or 308) to `/cindl/`.
- `GET /api/status` answers as it did before, and Hermes's own pages still
  work.

To update it, build the new version and switch the served directory to it in
one step. To remove it, stop serving `/cindl/`. Hermes is unchanged either
way.

## Not validated yet

The live connection lifecycle (sign-in, tickets, reconnect and replay,
approvals) has been read from the pinned Hermes source and exercised against a
fake Hermes, but not against an authenticated instance. Android sign-in has
run only on an emulator against the fake. The
[acceptance matrix](../project/acceptance-matrix.md) tracks both.

Installing, upgrading and removing the desktop and Android apps will be
described here when they are released.
