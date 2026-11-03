# apps/desktop

Electron shell around the `apps/web` renderer (ADR 0009). Non-negotiable:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`; load the renderer from a custom protocol with path
  traversal protection; block navigation and new windows; deny permission
  requests by default; strict CSP.
- The preload exposes only `window.cindlDesktop` (`DesktopBridge` in
  `@cindl/contracts`). Main validates every IPC call with `parseOpArgs` and
  rejects senders that are not the app's own frame.
- Tokens and the Hermes connection live in main. Persist tokens only with
  `safeStorage`; if encryption is unavailable keep them in memory and say so.
- Native sign-in: PKCE with a loopback listener bound to `127.0.0.1`, closed
  after one callback or a timeout.
- `openExternal` only for validated `https:` URLs.
