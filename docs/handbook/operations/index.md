# Running Cindl

**There is no deployment of Cindl yet.** Cindl is pre-release: nothing in this
repository is published, packaged for installation or validated against a live
Hermes. This page states what an operator will run, what exists today, and
which decisions block the rest.

There is no Cindl server to operate. Each client talks directly to an
existing, authenticated Hermes `hermes serve` backend
([ADR 0002](../architecture/decisions/0002-direct-hermes-transport.md)).

## How each client will reach Hermes

| Client  | Connection                                                                                                                                                                 | State today                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web     | Served from the same origin as `hermes serve` and signed in with Hermes's own session cookie. No tokens in the browser.                                                    | The production build exists, but nothing serves it from a Hermes origin: where to mount it is an [owner decision](../project/pending-decisions.md#same-origin-web-mount). Opened anywhere else, it says it is not connected and shows no data. |
| Desktop | The Electron main process connects to the `hermes serve` origin you sign in to, using Hermes's native PKCE flow with a loopback redirect. Tokens stay in the main process. | Not built yet.                                                                                                                                                                                                                                 |
| Android | The app connects to the `hermes serve` origin directly and signs in with the same native flow through the system browser. Tokens stay in Keystore-backed storage.          | Not built yet. No APK is produced.                                                                                                                                                                                                             |

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
  own. Signing out of a client forgets that device's tokens; Hermes v0.22.5
  cannot revoke issued native tokens remotely.

## What runs today

| What                             | How                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The web client on synthetic data | `pnpm --filter @cindl/web dev:demo`, on `127.0.0.1` only, always bannered as a demo ([Getting started](../development/getting-started.md)) |
| The production web bundle        | `pnpm --filter @cindl/web build`; checked in CI for synthetic fixture records and local paths, not served anywhere                         |
| This handbook                    | Built in CI and uploaded as a workflow artifact for review; not hosted                                                                     |

## Not validated yet

The live connection lifecycle (sign-in, tickets, reconnect and replay,
approvals) has been read from the pinned Hermes source but not exercised
against an authenticated instance. Android sign-in has not run on a device or
emulator. The [acceptance matrix](../project/acceptance-matrix.md) tracks both.

When a deployment path exists, this page will describe installing, signing in,
upgrading and removing each client, with the commands an operator runs.
