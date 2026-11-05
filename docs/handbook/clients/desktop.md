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

| Area                                           | State                                                                                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardened shell, `app://` renderer, bridge, CSP | Done; launch smoke-tested on both packaged AppImages, and in CI on the packaged Windows app                                                                                              |
| Linux x64 AppImages (Cindl, Cindl Demo)        | Built by CI (`.github/workflows/desktop.yml`); unsigned                                                                                                                                  |
| Sign-in and the live Hermes connection         | Native PKCE sign-in and the direct Hermes client run in main; tested end to end against the fake `hermes serve` (also in the packaged app); not validated against a live Hermes instance |
| The agent's screen, live                       | Main opens the screen socket and decodes it; the renderer paints `display.frame` pixels; tested against the fake's synthetic screen (also in the packaged app); not validated live       |
| Windows x64 installer (Cindl)                  | Built by CI on `windows-latest` and for releases; unsigned, so SmartScreen warns; never built or run on a Windows machine outside CI                                                     |
| macOS, `.deb`, auto-update, code signing       | Not provided                                                                                                                                                                             |

With no Hermes stored, Cindl opens **Not set up** and shows its sign-in screen;
nothing is invented. Once you sign in, the main process connects to your
`hermes serve` itself (the renderer only ever talks to main). It stays signed
in across restarts until you sign out, when the OS keyring can store the
tokens (see [Token storage](#token-storage)). Sign-in works against a
`hermes serve` that offers native sign-in. It has not yet been validated
against a live, authenticated Hermes instance, only against the fake
`hermes serve` in `@cindl/fixtures`.

## What it looks like

Both screenshots come from the packaged AppImages' smoke test.

![Cindl, signed out: the sign-in screen and the notice that tokens stay in memory without an OS keyring](/screenshots/desktop/real-signed-out.png)

![Cindl Demo: the synthetic demo, labelled by its banner](/screenshots/desktop/demo.png)

## Install

Each release carries the Linux AppImage and the Windows installer, each with a
`.sha256` file. Neither is code-signed: there is no signing certificate.
Check the checksum first. It only detects a damaged download; it does not
prove who built the file, since it comes from the same release page.

### Linux (AppImage)

1. Download `Cindl-<version>-x86_64.AppImage` and its `.sha256` file from the
   release into one directory.
2. Check it there: `sha256sum -c Cindl-<version>-x86_64.AppImage.sha256` must
   print `OK`.
3. Make it executable and start it:

   ```sh
   chmod +x Cindl-1.0.0-x86_64.AppImage
   ./Cindl-1.0.0-x86_64.AppImage
   ```

The AppImage needs FUSE 2 to mount itself (`libfuse2t64` on Ubuntu 24.04);
without it, run it with `--appimage-extract-and-run`. On Ubuntu 23.10 and
later, also read
[Chromium sandbox](#chromium-sandbox-on-ubuntu-23-10-and-later) below. Between
releases, a successful **Desktop** workflow run on `main` offers both
AppImages (`cindl-desktop-linux-x64-appimage`,
`cindl-demo-desktop-linux-x64-appimage`) with the same `.sha256` files;
pull-request builds are tested but never published.

### Windows (installer)

1. Download `Cindl-Setup-<version>.exe` and its `.sha256` file from the
   release into one folder.
2. Check it there in PowerShell; this must print `True`:

   ```powershell
   (Get-FileHash .\Cindl-Setup-1.0.0.exe).Hash -eq (Get-Content .\Cindl-Setup-1.0.0.exe.sha256).Split(' ')[0]
   ```

3. Run the installer. Because it is unsigned, SmartScreen stops it with
   "Windows protected your PC": choose **More info**, then **Run anyway**. It
   installs Cindl for your Windows account, without administrator rights,
   and adds it to the Start menu.

Cindl keeps its settings and tokens in `%APPDATA%\Cindl`. Uninstalling (in
Settings, Apps) leaves that folder; delete it to remove them, which also signs
this device out.

## Sign-in (native PKCE)

This is the flow the main process runs for Hermes v0.22.5, through the direct
client (`@cindl/client-core`) and the adapter's native sign-in: the same
implementation Android uses. Hermes must run with a sign-in provider and offer
`native_pkce` in `auth_flows` (`GET /api/status`); a server in loopback-token
mode, or one without native sign-in, is refused with that reason.

1. You enter the address of your `hermes serve` backend on the sign-in screen.
   It must be `https://`;
   plain `http://` is accepted only for `127.0.0.1` or `[::1]` on the same
   machine. User names, passwords, paths, queries, fragments, trailing-dot hosts
   and port 0 are refused (the contract's `HermesOrigin` rule), and only the
   normalized origin is stored.
2. Cindl asks you to confirm that address in a native dialog. The request to
   sign in comes from the renderer, which displays agent output, so nothing is
   sent anywhere, and the browser does not open, until you confirm. Only one
   confirmation can be open at a time.
3. Cindl starts a listener on `127.0.0.1` with a random port and opens your
   system browser at `GET /auth/native/authorize` with an S256 PKCE challenge, a
   random `state` and the redirect `http://127.0.0.1:<port>/callback`. Hermes
   accepts only loopback IP redirects; Cindl does not relax that.
4. You sign in on Hermes's own page. Passwords and second factors are never
   typed into Cindl.
5. The listener accepts exactly one callback with the matching `state` (other
   paths, methods, malformed targets, `Host` headers and states are refused),
   then closes. It also closes after five minutes or when another sign-in
   replaces it. Meanwhile the sign-in screen stays: "Stop waiting" frees its
   form for another try, and a refusal shows there.
6. Main exchanges the code with `POST /auth/native/token {code, code_verifier}`
   and stores the token set. Before the access token expires it calls
   `POST /auth/native/refresh`; concurrent callers share one refresh because the
   refresh token rotates. A `401` from refresh means the session expired: Cindl
   forgets the tokens and asks you to sign in again. A refresh that was in
   flight when you signed out never writes the old session back.

Tokens never reach the renderer. Main sends requests and opens WebSockets
only to the origin you confirmed: the fetch and sockets it hands the client are
pinned to it, and the single-use gateway ticket travels in the
`hermes-gateway-ticket.<ticket>` subprotocol, never in the URL (the screen
socket is the one exception Hermes imposes; see
[The agent's screen](#the-agent-s-screen)). The stored
origin is re-checked against the same rules before every use, and each
encrypted token record names its origin, so an edited settings file cannot send
a token somewhere else or over plain http.

**Switching Hermes is all or nothing.** Signing in to a different Hermes
changes nothing until it succeeds. Only then does Cindl store the new address
and forget the previous Hermes's tokens. If the sign-in fails or is cancelled
(in the browser, or by the five-minute timeout), Cindl goes back to the Hermes
it was using, with the same address and tokens and without a restart, and a
notice at the top of the window says why. Quitting while the browser is still
open leaves the device on the previous Hermes as well. A newer sign-in, or
signing out, replaces a sign-in that is still waiting for the browser. If the
previous tokens cannot be removed at once, a notice says so and Cindl removes
them at its next start.

**Sign-out is local.** It deletes this device's tokens. Hermes v0.22.5 cannot
revoke native tokens it has issued, so sign-out does not end sessions anywhere
else, and the app says so.

## The agent's screen

When Hermes reports that the profile's agent-owned screen is running, **Work**
shows it live under **Computer** (ADR 0012). Cindl never starts, stops or
installs that screen; when it is stopped, Work says so.

- **The ticket stays in main.** Main asks Hermes for a single-use ticket
  (`display.observe`) and opens the screen's WebSocket itself. Hermes accepts
  that ticket only in the URL (`/api/display/ws?display_ticket=…`), so main
  opens that socket only to `/api/display/ws` on the origin you confirmed, with
  the ticket as its only query parameter, and never puts the URL in a log line
  or an error. The ticket, the viewer id and the RFB stream never reach the
  renderer.
- **Pixels, not the stream.** The direct client decodes the RFB stream in
  main. After painting, the renderer asks for what changed (`display.frame`)
  and receives only the changed regions' pixels, as `Uint8Array`s that the
  bridge copies across. When nothing changes, the call returns no regions
  after two seconds. A full 640x400 picture is 1,024,000 bytes. In the smoke
  test on a 4-vCPU Linux VM it reached the page in a median of about 7 ms,
  and a small update in about 1 ms.
- **Input only in control.** Pointer and keyboard input go to the screen only
  while this device holds control (**Take control…**, then confirm). Main
  refuses input otherwise, and Hermes filters it as well. Leaving Work closes
  the socket, which hands control back. Input and frames are never logged or
  stored.
- **An open view keeps the screen running.** After 15 seconds without a byte
  from the screen, Cindl asks for one pixel to check that the stream is alive,
  and Hermes counts a connected viewer as use. The screen's idle stop therefore
  does not apply while Work shows it; leave Work to let it stop.

## Token storage

Tokens are encrypted with Electron `safeStorage` (the asynchronous API) and kept
as ciphertext in `~/.config/Cindl/secrets.json` (mode `0600`). On Linux this
needs a working keyring: GNOME libsecret or KWallet. On Windows `safeStorage`
uses DPAPI, which ties the ciphertext to your Windows account, and the file is
`%APPDATA%\Cindl\secrets.json`; the keyring checks below are Linux's.

If the operating system offers no real encryption, tokens stay **in memory
only** and are forgotten when Cindl quits; nothing is written to disk. Cindl
treats these as no encryption:

- Electron's `basic_text` backend, which reports encryption as available but
  uses a fixed password;
- a keyring that cannot be reached: Cindl encrypts a probe at startup, and if
  Chromium fell back to its built-in key (ciphertext marked `v10`) it does not
  persist tokens, whatever backend name Electron reports.

Cindl logs the reason at startup and shows a warning notice at the top of the
window, above the sign-in screen or the current view.

If the keyring refuses to encrypt later, while Cindl runs, the same place shows
a warning at once, and Cindl keeps every token in memory until it quits, even if
the keyring works again: it writes no token to disk for the rest of the run,
and removes the encrypted copy of each token it replaces. Switching Hermes and
signing out still delete encrypted records from disk then, so no other
Hermes's tokens stay behind. After the restart you sign in again.

Other files in `~/.config/Cindl`: `settings.json` (non-secret: the Hermes
origin and client bookkeeping, mode `0600`) and `window-state.json`. Cindl Demo
uses `~/.config/Cindl Demo` and stores no tokens.

## Security model

- **Two trust levels.** Main is trusted. The renderer is not: it displays agent
  output. It runs with `contextIsolation`, `sandbox`, `webSecurity`, no Node
  integration, no `<webview>` and no spellchecker. Chromium still asks for a
  component download (`redirector.gvt1.com`) once per launch; the renderer
  session's dead proxy refuses it.
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
  script runs. Where it remains (see the known gap below), three settings
  contain it, and the packaged smoke test checks each by behaviour: the dead
  proxy keeps its TCP off other machines, its `<-loopback>` rule keeps that TCP
  from going straight to loopback, and the IP-handling policy
  (`disable_non_proxied_udp`) keeps its UDP off the network. Main's own Hermes
  traffic does not use this session.
- **Known gap: WebRTC in child frames.** Electron runs no preload in a
  same-origin `about:blank` child frame, even with `nodeIntegrationInSubFrames`,
  so script in a compromised renderer can create one and create peer
  connections from it. Measured in the packaged smoke test (and under strace in
  review): from a child frame, TURN and ICE over TCP reach only the dead proxy
  (127.0.0.1:9, refused), loopback targets included, no other machine is
  dialled, and no UDP is sent. What remains is the API itself, contained by
  those three settings. A page cannot be stopped from reaching a child frame's
  window (`window[0]`), and Electron has no switch that turns WebRTC off. The
  smoke test checks the containment, and the threat model tracks it.
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

- Linux x64 AppImages and a Windows x64 installer, all unsigned (SmartScreen
  warns on Windows); no macOS build, no auto-update, no build provenance
  attestation. The Windows app has been launch-tested only by CI's smoke test.
- Hermes must present a certificate that Node's bundled CA list trusts; private
  certificate authorities are not supported yet.
- Single window, single instance: starting Cindl again focuses the open window.
- A compromised renderer can still call allowlisted operations, including owner
  edits with `confirm: true` and approval answers; only sign-in has a
  main-owned confirmation so far.
- Sign-in, the live connection and the agent's screen have been exercised
  only against the fake `hermes serve` in `@cindl/fixtures`, which follows
  Hermes v0.22.5's rules (integration tests in
  `apps/desktop/test/transport.test.ts` and the packaged smoke test). They
  have not been validated against a live, authenticated Hermes instance.
- The screen uses uncompressed (Raw) RFB updates: a full 1920x1080 picture is
  about 8 MB on the socket and again across the bridge. Each screen socket
  message may be at most 16 MiB.

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
| The app says "Not set up"                      | Enter your `hermes serve` address on the sign-in screen and confirm it in the dialog.          |
| "Hermes is running in loopback-token mode"     | Configure a sign-in provider (password or OAuth) on Hermes; Cindl never reads that token.      |
| "does not offer native sign-in"                | That Hermes has no `native_pkce` flow in `auth_flows`; update or configure it.                 |
| Warning that tokens stay in memory only        | No usable keyring. Install and unlock GNOME Keyring or KWallet, or accept signing in again.    |
| "Sign-in to … did not complete"                | Cindl stayed on the Hermes you were using. Check the address and native sign-in, then retry.   |
| Work says the agent screen is not running      | Start it on Hermes (the agent or the Hermes CLI). Cindl never starts, stops or installs it.    |
| A link does nothing                            | Only `https://` links open, right after a click. The terminal shows "Refused to open a link".  |
| Window opens off screen after a monitor change | Cindl drops saved positions that are no longer on a screen; delete `window-state.json` if not. |
| Start from a clean state                       | Quit Cindl and delete `~/.config/Cindl` (`%APPDATA%\Cindl` on Windows); a local sign-out.      |
| Windows: "Windows protected your PC"           | The installer is unsigned. After checking its SHA-256, choose More info, then Run anyway.      |

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
pnpm --filter @cindl/desktop run package:win      # on Windows: installer in apps/desktop/release/real
```

Launch smoke tests (`apps/desktop/e2e/smoke.spec.ts`) drive both flavours with
Playwright. Without an X server, add `CINDL_SMOKE_HEADLESS=1`; to test packaged
AppImages, set `CINDL_SMOKE_REAL` and `CINDL_SMOKE_DEMO` to their paths. On a
host where Chromium's sandbox cannot start, the tests run the app with
`CINDL_UNSAFE_NO_SANDBOX=1`; CI runs them with the sandbox on
(`CINDL_SMOKE_SANDBOX=1`). Besides the hardening, they check the conversation
panel (ADR 0013) in Cindl Demo: a column in the default window (1360px wide,
so its page is at least 1280px, the panel's breakpoint, even with a window
frame) and a sheet at 960px, with its tools,
`Ctrl+.` and Escape. In the real app they check that the sign-in screen stays,
with "Stop waiting", while main waits for the system browser.

```sh
CINDL_SMOKE_HEADLESS=1 pnpm --filter @cindl/desktop run smoke
```
