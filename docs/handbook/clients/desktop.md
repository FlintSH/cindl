# Desktop (Electron)

Cindl desktop is an Electron shell around the production web build
(`apps/web`). The renderer looks and behaves like the web client; the main
process holds Hermes tokens and the Hermes connection and answers the renderer
only through a small, validated bridge (ADR 0009).

There are two packages (ADR 0011):

- **Cindl**, the real app. It contains no synthetic data and has no demo
  switch.
- **Cindl Demo**, a separate package with its own name, app id and settings
  directory. It runs the synthetic scenario in the main process. It is labelled
  three ways: the renderer's notice ("Synthetic demo. Not connected to Hermes;
  every name, message and status here is invented."), the window title
  "Cindl Demo (synthetic demo)" and the product name.

Both load the same production renderer. Packaging fails if the real app
contains any synthetic fixture record (`SYNTHETIC_FIXTURE_MARKERS`) or if a
renderer lacks the demo notice copy.

## Status

| Area                                                  | State                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Hardened shell, `app://` renderer, bridge, CSP        | Done; launch smoke-tested on both packaged AppImages                                                        |
| Linux x64 AppImages (Cindl, Cindl Demo)               | Built by CI (`.github/workflows/desktop.yml`); unsigned                                                     |
| Native sign-in pieces (PKCE, loopback, token storage) | Built and tested against a local fake `hermes serve`; never run against a real Hermes instance              |
| Live Hermes connection                                | Not yet: waits for the direct Hermes client (`createDirectClient`, client-core). Sign-in is refused for now |
| macOS, Windows, `.deb`, auto-update, code signing     | Not provided                                                                                                |

Until the live connection lands, Cindl opens in an honest **Not set up**
state: every capability shows as unknown with the reason, and nothing is
invented. `auth.signIn` answers "This build of Cindl desktop cannot connect to
Hermes yet" and sends nothing.

## What it looks like

Both screenshots come from the packaged AppImages' smoke test.

![Cindl, signed out: the sign-in screen and the notice that tokens stay in memory without an OS keyring](/screenshots/desktop/real-signed-out.png)

![Cindl Demo: the synthetic demo, labelled by its banner and window title](/screenshots/desktop/demo.png)

## Install the AppImage

1. Download `cindl-desktop-linux-x64-appimage` (or
   `cindl-demo-desktop-linux-x64-appimage`) from a successful run of the
   **Desktop** workflow **on `main`**. Pull-request builds are tested but never
   published. The artifact holds the AppImage and a `.sha256` file; the
   checksum only detects a damaged download, it does not prove who built it.
2. Check it: `sha256sum -c Cindl-<version>-x86_64.AppImage.sha256`.
3. Make it executable and start it:

   ```sh
   chmod +x Cindl-0.1.0-x86_64.AppImage
   ./Cindl-0.1.0-x86_64.AppImage
   ```

The AppImages are not code-signed. They need FUSE 2 to mount themselves
(`libfuse2t64` on Ubuntu 24.04); without it, run them with
`--appimage-extract-and-run`. On Ubuntu 23.10 and later, also read
[Chromium sandbox](#chromium-sandbox-on-ubuntu-23-10-and-later) below.

## Sign-in (native PKCE)

This is the flow the main process implements for Hermes v0.22.5. It is enabled
together with the live connection.

1. You enter the address of your `hermes serve` backend. It must be `https://`;
   plain `http://` is accepted only for `127.0.0.1` or `[::1]` on the same
   machine. User names, passwords, paths, queries, fragments, trailing-dot hosts
   and port 0 are refused (the contract's `HermesOrigin` rule), and only the
   normalized origin is stored.
2. Cindl asks you to confirm that address in a native dialog. The request to
   sign in comes from the renderer, which displays agent output, so nothing
   starts without this confirmation.
3. Cindl starts a listener on `127.0.0.1` with a random port and opens your
   system browser at `GET /auth/native/authorize` with an S256 PKCE challenge, a
   random `state` and the redirect `http://127.0.0.1:<port>/callback`. Hermes
   accepts only loopback IP redirects; Cindl does not relax that.
4. You sign in on Hermes's own page. Passwords and second factors are never
   typed into Cindl.
5. The listener accepts exactly one callback with the matching `state` (other
   paths, methods, malformed targets, `Host` headers and states are refused),
   then closes. It also closes after five minutes or when another sign-in
   replaces it.
6. Main exchanges the code with `POST /auth/native/token {code, code_verifier}`
   and stores the token set. Before the access token expires it calls
   `POST /auth/native/refresh`; concurrent callers share one refresh because the
   refresh token rotates. A `401` from refresh means the session expired: Cindl
   forgets the tokens and asks you to sign in again. A refresh that was in
   flight when you signed out never writes the old session back.

Tokens never reach the renderer. The stored origin is re-checked against the
same rules before every use, and each encrypted token record names its origin,
so an edited settings file cannot send a token somewhere else or over plain
http.

**Sign-out is local.** It deletes this device's tokens. Hermes v0.22.5 cannot
revoke native tokens it has issued, so sign-out does not end sessions anywhere
else, and the app says so.

## Token storage

Tokens are encrypted with Electron `safeStorage` (the asynchronous API) and kept
as ciphertext in `~/.config/Cindl/secrets.json` (mode `0600`). On Linux this
needs a working keyring: GNOME libsecret or KWallet.

If the operating system offers no real encryption, tokens stay **in memory
only** and are forgotten when Cindl quits; nothing is written to disk. Cindl
treats these as no encryption:

- Electron's `basic_text` backend, which reports encryption as available but
  uses a fixed password;
- a keyring that cannot be reached: Cindl encrypts a probe at startup, and if
  Chromium fell back to its built-in key (ciphertext marked `v10`) it does not
  persist tokens, whatever backend name Electron reports.

Cindl logs the reason at startup and sends the renderer a warning notice. If
the keyring refuses to encrypt later, that token also stays in memory.

Other files in `~/.config/Cindl`: `settings.json` (non-secret: the Hermes
origin and client bookkeeping, mode `0600`) and `window-state.json`. Cindl Demo
uses `~/.config/Cindl Demo` and stores no tokens.

## Security model

- **Two trust levels.** Main is trusted. The renderer is not: it displays agent
  output. It runs with `contextIsolation`, `sandbox`, `webSecurity`, no Node
  integration, no `<webview>` and no spellchecker (so no dictionary downloads).
  `app.enableSandbox()` sandboxes every renderer.
- **No sandbox, no start.** Cindl refuses to run when Chromium's sandbox is
  turned off (`--no-sandbox`, `--no-zygote-sandbox`,
  `--disable-seccomp-filter-sandbox` or `ELECTRON_DISABLE_SANDBOX`). AppImage
  launchers add `--no-sandbox` on their own when unprivileged user namespaces
  are unavailable; Cindl then shows an error and exits instead of running agent
  output unconfined. `CINDL_UNSAFE_NO_SANDBOX=1` overrides this for test hosts
  that cannot start the sandbox at all. Do not set it for normal use.
- **One origin.** The renderer is the packaged production web build, served
  from `app://cindl/`. The handler serves one directory and refuses dot
  segments (plain or percent-encoded), encoded slashes and backslashes, NUL and
  control characters, absolute paths, drive letters, hidden files, unknown file
  types and symlinks that resolve outside that directory. Every response has
  `X-Content-Type-Options: nosniff`, `X-DNS-Prefetch-Control: off` and this
  policy:

  ```text
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
  font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none';
  frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none';
  form-action 'none'; base-uri 'none'; frame-ancestors 'none'
  ```

- **Not framable, not navigable.** The renderer cannot be framed
  (`frame-ancestors 'none'`) and cannot frame anything. Electron only ever loads
  the app protocol: navigation away from `app://cindl` is blocked, new windows
  are denied, redirects and `<webview>` are refused.
- **No network from the renderer.** Its session cancels every `http`, `https`,
  `ws` and `wss` request, and sends anything else to a proxy that cannot
  connect (the discard port on loopback, with loopback not exempted). WebRTC,
  which the CSP cannot restrict, is removed from the top frame before any
  script runs; as a second layer it may only use that dead proxy, which stops
  it from reaching any other machine (Chromium still lets WebRTC open TCP
  connections to loopback directly). Main's own Hermes traffic does not use
  this session.
- **Known gap: WebRTC in child frames.** Electron runs no preload in a
  same-origin `about:blank` child frame, even with `nodeIntegrationInSubFrames`,
  so script in a compromised renderer can create one and use WebRTC from it.
  The dead proxy still keeps it off other machines; what remains is TCP to
  loopback with ICE/STUN framing, mainly port probing. A page cannot be
  stopped from reaching a child frame's window (`window[0]`), and Electron has
  no switch that turns WebRTC off. The smoke test pins this behaviour, and the
  threat model tracks it.
- **Permissions and devices.** Every permission request and check is denied,
  device pickers (HID, serial, USB, Bluetooth) are cancelled, screen capture
  is refused and downloads are blocked.
- **The bridge.** The preload exposes exactly one object,
  `window.cindlDesktop` (`DesktopBridge`), and only on `app://cindl`. Main
  answers only the four `desktopChannels` and checks every message: the sender
  must be the main frame of the Cindl window on `app://cindl`; the operation
  must be a known `clientOps` name; the arguments must pass that operation's
  schema (including the narrow id charsets), and only the parsed arguments go
  on. Failures come back as a plain `{code, message}` error (Electron drops
  custom properties from `Error` objects crossing the bridge).
- **Links.** Markdown links open in the system browser, and only as `https://`
  URLs without credentials, whitespace or backslashes; `javascript:`, `file:`,
  `data:` and custom schemes are refused. A link opens only right after a click
  or an Enter/Space press that main saw arrive from the operating system, one
  link per gesture, and at most five in ten seconds. A compromised renderer can
  therefore not open the browser on its own; it can still turn one of your
  clicks into a different `https` destination than the one it displays.
- **Native files.** `saveText` shows the native save dialog, and only right
  after a click or Enter/Space that main saw (one dialog per gesture, like a
  link). The renderer only suggests a base name (separators, control and bidi
  characters removed). New files are created with mode `0600`; an existing
  file keeps its permissions.
- **Logs** go to standard error, never to a file, and every line passes
  through the adapter's `redactText`/`redactValue` plus a header pass for
  `Cookie`, `Set-Cookie` and `Authorization`. Set `CINDL_LOG=debug` for more
  detail.
- **Developer tools** are available only in unpacked development builds, or
  with `CINDL_DEVTOOLS=1`.
- **Electron fuses** (set at package time): `RunAsNode`, `NODE_OPTIONS` and
  file-protocol extra privileges are off; cookie encryption and "only load the
  app from `app.asar`" are on. `--inspect` arguments stay enabled so CI can
  smoke-test the exact AppImage it ships through the Node inspector. That also
  lets a process running as you start the main-process inspector (for example
  with `SIGUSR1`). On Linux such a process can already read your keyring, so
  the fuse protects nothing there; it must be turned off before any signed
  macOS or Windows build, where the keychain trusts the signed app.

## Limits

- No live Hermes connection yet; sign-in is refused (see Status).
- Linux x64 AppImages only, unsigned, no auto-update, no build provenance
  attestation.
- Hermes must present a certificate that Node's bundled CA list trusts; private
  certificate authorities are not supported yet.
- Single window, single instance: starting Cindl again focuses the open window.
- A compromised renderer can still call allowlisted operations, including owner
  edits with `confirm: true` and approval answers; only sign-in has a
  main-owned confirmation so far.
- The native sign-in has been exercised only against a local fake server that
  follows Hermes v0.22.5's rules. It has not been validated against a live,
  authenticated Hermes instance.

## Troubleshooting

### Chromium sandbox on Ubuntu 23.10 and later

If Cindl says it "will not run with Chromium's sandbox turned off", the kernel
stopped Chromium from creating the user namespace its sandbox needs
(`kernel.apparmor_restrict_unprivileged_userns=1`), the AppImage launcher
(`AppRun`) added `--no-sandbox` because of that, and Cindl refused to start.
An AppImage cannot use a setuid helper while mounted. Options:

- Allow unprivileged user namespaces system-wide:
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. The
  AppImage then works as is. This is what CI does before its smoke test.
- Narrower, per app: extract the AppImage (`--appimage-extract`), then either
  make `squashfs-root/chrome-sandbox` owned by root with mode `4755`, or add an
  AppArmor profile that grants `userns` to `squashfs-root/cindl`. Start
  `squashfs-root/cindl` directly: `AppRun` would add `--no-sandbox` again.

These are general Chromium-on-Ubuntu measures; only the first one is exercised
by Cindl's CI.

### Other problems

| Symptom                                        | What to do                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| "AppImages require FUSE to run"                | Install `libfuse2t64`, or start with `--appimage-extract-and-run`.                             |
| The app says "Not set up"                      | Expected in this build: the live Hermes connection is not integrated yet.                      |
| Warning that tokens stay in memory only        | No usable keyring. Install and unlock GNOME Keyring or KWallet, or accept signing in again.    |
| A link does nothing                            | Only `https://` links open, right after a click. The terminal shows "Refused to open a link".  |
| Window opens off screen after a monitor change | Cindl drops saved positions that are no longer on a screen; delete `window-state.json` if not. |
| Start from a clean state                       | Quit Cindl and delete `~/.config/Cindl`. This also forgets tokens (local sign-out).            |

## Development

```sh
pnpm --filter @cindl/web build                    # production renderer, required first
pnpm --filter @cindl/desktop run build            # real flavour into apps/desktop/dist
pnpm --filter @cindl/desktop run build:demo       # Cindl Demo into apps/desktop/dist-demo
pnpm --filter @cindl/desktop start                # run the unpacked real app
pnpm --filter @cindl/desktop run start:demo       # run the unpacked Cindl Demo
pnpm vitest run --project desktop                 # unit tests (apps/desktop/test)
pnpm --filter @cindl/desktop run package          # AppImage in apps/desktop/release/real
pnpm --filter @cindl/desktop run package:demo     # AppImage in apps/desktop/release/demo
```

Launch smoke tests (`apps/desktop/e2e/smoke.spec.ts`) drive both flavours with
Playwright. Without an X server, add `CINDL_SMOKE_HEADLESS=1`; to test packaged
AppImages, set `CINDL_SMOKE_REAL` and `CINDL_SMOKE_DEMO` to their paths. On a
host where Chromium's sandbox cannot start, the tests run the app with
`CINDL_UNSAFE_NO_SANDBOX=1`; CI runs them with the sandbox on
(`CINDL_SMOKE_SANDBOX=1`).

```sh
CINDL_SMOKE_HEADLESS=1 pnpm --filter @cindl/desktop run smoke
```
