# apps/desktop

Electron shell around the `apps/web` renderer (ADR 0009). User and operator
documentation: `docs/handbook/clients/desktop.md`. Non-negotiable:

- Two flavours (ADR 0011): the real app (`src/main/index.ts`) bundles no
  fixture records and has no demo switch; Cindl Demo (`src/main/demo.ts`, the
  only main-process file that may import `@cindl/fixtures`) has its own product
  name, app id, output dir and window title. Both load the same production
  renderer; the gates in `scripts/gates.ts` fail a real output with any
  `SYNTHETIC_FIXTURE_MARKERS` and any renderer without the demo notice.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  (`app.enableSandbox()`), `webSecurity: true`; refuse to start when Chromium's
  sandbox is off (`src/main/guards.ts`, checked before `enableSandbox()`); the
  renderer is served from `app://cindl/` by `src/main/protocol.ts` (traversal,
  encoded dot segments, NUL, absolute paths and symlink escapes refused); the
  CSP header keeps `connect-src 'none'` and `frame-ancestors 'none'`. Block
  navigation and new windows; deny permissions; the renderer session cancels
  every http(s)/ws(s) request and uses a dead proxy; WebRTC is removed from the
  top frame (child frames keep it: a known gap, see clients/desktop.md).
- The preload exposes only `window.cindlDesktop` (`DesktopBridge`), only on
  `app://cindl`, and may import only `electron` and Node-free modules (the
  build fails otherwise). Main answers only `desktopChannels`, checks the
  sender (main frame of the app window on `app://cindl`), `isOpName`, then
  `parseOpArgs`, and passes on only the parsed arguments.
- Tokens and the Hermes connection live in main. Persist tokens only with
  `safeStorage` and only after the keyring probe passes (`basic_text` or a
  `v10` probe means memory only). Once the keyring refuses to encrypt, the
  store stays memory-only for the run and warns at once; its `available`
  stays true so deletes always reach the disk. Never log a token, ticket,
  code, verifier or cookie: log through `src/main/log.ts`.
- The screen socket's URL carries the display ticket: only main opens it,
  through `checkDisplaySocketRequest`, and the renderer gets `display.frame`
  pixels only.
- Hermes origins: the contract's `HermesOrigin` rule
  (`src/main/platform/origin-policy.ts`), re-checked on every stored read.
- Native sign-in: a main-owned confirmation of the origin first; PKCE with a
  loopback listener bound to `127.0.0.1`, one matching-state callback, then
  closed (or on timeout, cancel or replacement). Switching origin is all or
  nothing (`session.ts`): store the origin and forget the old tokens only
  after success; on failure restore the pin and restart on the old origin.
- `openExternal` only for validated `https:` URLs, only right after a trusted
  click or Enter/Space (`createGestureTracker`), rate limited.

## Layout

| Path                   | What                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `src/main/app.ts`      | Shared main process: lifecycle, window, wiring (`runCindl(flavour)`)     |
| `src/main/index.ts`    | Real flavour entry                                                       |
| `src/main/session.ts`  | The direct Hermes client on the platform pieces; all-or-nothing sign-in  |
| `src/main/demo.ts`     | Cindl Demo entry (synthetic scenario)                                    |
| `src/main/ipc.ts`      | Channel handlers, sender checks, `BridgeReply` envelopes                 |
| `src/main/host.ts`     | Owns the main-process `CindlClientApi`; mirror store and snapshot replay |
| `src/main/security.ts` | Session and webContents hardening                                        |
| `src/main/guards.ts`   | Sandbox check, user-gesture tracker                                      |
| `src/main/platform/`   | Secret store, settings store, gateway and screen sockets, loopback       |
| `src/preload/index.ts` | The bridge                                                               |
| `scripts/`             | Flavoured esbuild build, gates, licences, electron-builder packaging     |
| `e2e/smoke.spec.ts`    | Playwright launch smoke of both flavours (unpacked or packaged)          |

## Commands

```sh
pnpm --filter @cindl/web build && pnpm --filter @cindl/desktop run build
pnpm --filter @cindl/desktop run build:demo
pnpm vitest run --project desktop
CINDL_SMOKE_HEADLESS=1 pnpm --filter @cindl/desktop run smoke
flock /tmp/cindl-heavy-build.lock pnpm --filter @cindl/desktop run package
flock /tmp/cindl-heavy-build.lock pnpm --filter @cindl/desktop run package:demo
```

## Lessons

- `contextBridge` copies an `Error` with its message only; failed calls reject
  with a plain `CindlErrorShape` so the renderer keeps the code.
- The renderer subscribes while it loads: register the trusted window before
  `loadURL`, and replay a snapshot on every `subscribe` signal (reloads).
- `app.enableSandbox()` removes `--no-sandbox` from `app.commandLine` but the
  zygote already started unsandboxed: check the switches first.
- AppImage's `AppRun` adds `--no-sandbox` when `unshare -Ur` fails; the
  `.desktop` entry must keep `executableArgs: []`.
- `safeStorage` reports libsecret/encryption available even when it fell back
  to Chromium's built-in key: probe-encrypt and reject `v10`.
- WebRTC is removed from the top frame with `contextBridge.executeInMainWorld`.
  Preloads never run in `about:blank` child frames, even with
  `nodeIntegrationInSubFrames`, so those keep it. Three settings contain it,
  each checked by behaviour in the smoke test: without the dead proxy its TCP
  dials other machines, without `<-loopback>` it connects straight to
  loopback, and without the IP-handling policy its UDP leaves.
- Measure WebRTC by STUN framing or by process, never by raw connection
  counts: other local processes probe new loopback ports.
- Headless ozone reports a 1x1 screen: pass `--ozone-override-screen-size`.
- The `EnableNodeCliInspectArguments` fuse stays on (Playwright drives the
  packaged binary through `--inspect`); turn it off before any signed macOS
  or Windows build.
