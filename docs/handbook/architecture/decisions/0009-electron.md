# 0009 Electron with the web renderer and a hardened main process

**Status:** Accepted (implementation pending)

**Decision.** The desktop app loads the production web build through a custom
protocol with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, a strict CSP, blocked navigation and window creation, and
denied permissions by default. The preload exposes only `window.cindlDesktop`
(`DesktopBridge` in contracts). The main process holds tokens and the Hermes
connection, validates every IPC call and sender, and owns native file dialogs.
