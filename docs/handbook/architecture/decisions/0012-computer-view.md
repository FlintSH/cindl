# 0012 Computer view: the RFB stream stays inside the client implementation

**Status:** Proposed. Built: the contract operations, the RFB client core (`packages/client-core/src/rfb.ts`), the web viewer, the synthetic screen, and the Hermes transport in the direct client (`packages/client-core/src/direct/screen.ts`: `display.observe`, `/api/display/ws`, lease-gated input), tested against the fake Hermes; and the desktop app's screen socket in its main process (`apps/desktop/src/main/platform/websocket.ts`), so the real desktop app shows the screen, tested against the fake Hermes and packaged. Not built: a screen socket for Android or the web client, which show `computer.view` as limited. Not validated against a live Hermes.

**Context.** Hermes v0.22.5 shows a profile's agent-owned screen through
three pieces (`tui_gateway/methods_display.py`, `hermes_cli/web_routers/display.py`):

- `display.observe` mints a single-use ticket that expires after 30 s, plus a
  `viewer_id` for this connection. The screen must already be running; observe
  never starts it.
- `/api/display/ws?display_ticket=<ticket>` splices the screen's RFB socket
  into a WebSocket as binary frames. The ticket rides in the query string
  because noVNC cannot set a header or a subprotocol. The client picks
  security type None and Hermes forces a shared session.
- `display.lease.acquire` / `release` (Take over / Hand back) name the
  `viewer_id`. Hermes's `RfbClientFilter` drops keyboard, pointer and
  clipboard messages from any viewer that does not hold the lease, and a lease
  change closes an evicted viewer with 4000 `control-taken`.

In the desktop app the renderer displays agent output and is treated as
untrusted: tokens and tickets live in the main process only (invariant 3).
The ticket is a bearer credential for the screen, so it must not reach the
desktop renderer either. Android keeps tokens in the Keystore, out of the
React tree, for the same reason.

**Decision.**

- **One RFB client, in `client-core`.** It is a protocol state machine over a
  byte-stream socket the platform provides: version and security handshake
  (None only), ServerInit, a fixed 32-bit true-colour pixel format, the Raw
  and CopyRect encodings and the DesktopSize pseudo-encoding. Compressed
  encodings (Tight, ZRLE) come later, behind a zlib interface the platform
  supplies.
- **The platform supplies the socket.** `BinaryWebSocketFactory`
  (`packages/client-core/src/platform.ts`) opens a binary WebSocket whose
  messages arrive as bytes. A platform without one leaves the live picture
  unavailable instead of falling back to anything else.
- **It runs where the ticket lives:** inside the `CindlClientApi`
  implementation. That is the desktop main process, the web page itself
  (same-origin with Hermes, already holding the session cookie, so the ticket
  adds no power it lacks), and the Android client outside the UI tree. UI code
  never sees a ticket, a `viewer_id` or raw RFB.
- **Contract (additive, in one change):**
  - `display.watch {}` returns `{ viewId, width, height }` under
    `computer.view`. It fails `unavailable` when the screen is stopped and
    never starts it.
  - `display.frame { viewId }` returns what changed since the viewer's last
    call: `{ viewId, width, height, regions }`, each region being
    `{ x, y, width, height, rgba }`. It waits briefly for a change. Frames are
    results, not events, so pixels never pass through the reducer.
  - `display.unwatch { viewId }`.
  - `display.input { viewId, events }` under `computer.control`, for up to 64
    pointer and key events (DOM `KeyboardEvent.key` values). It is refused
    unless this device holds the lease, and Hermes filters input as well.
- **Pull, not push.** The UI asks for the next update when it has painted.
  The client keeps only the newest pixels for each region, so a slow renderer
  (or IPC) never builds an unbounded queue. In the desktop app each region is
  copied across IPC (structured clone) and again by the bridge: a full
  640x400 frame (1 MB) takes about 7 ms in the packaged app, a small update
  about 1 ms.
- **Privacy.** Frames are never stored, logged or attached to diagnostics.
  Input events are never logged, because typing on the screen can be secret
  entry. The viewer always says whether you are watching or in control.
  Viewing never starts, stops or installs a screen.
- **Tests and demo.** A fake RFB server in `packages/fixtures` serves a
  synthetic, labelled framebuffer. The decoder and the input gate are tested
  end to end against it, and the labelled demo shows that synthetic picture
  through the same client.

**Consequences.**

- Three clients share one RFB implementation and none of them puts the
  ticket in a renderer.
- Raw encoding is heavy (a full 1280x800 frame is 4 MB), so updates are
  incremental and pulled until a compressed encoding lands.
- In the web client the ticket briefly exists in the page. That page is
  same-origin with Hermes and already holds the session cookie, which is
  documented in the threat model.
- Nothing here is validated against a live Hermes until the owner authorises
  a live run.
