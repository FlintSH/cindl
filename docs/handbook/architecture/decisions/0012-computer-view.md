# 0012 Computer view: the RFB stream stays inside the client implementation

**Status:** Proposed (the RFB client core, `packages/client-core/src/rfb.ts`, is built and tested against a synthetic byte stream; nothing is wired yet, so Cindl still shows only the screen's state and lease)

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
- **It runs where the ticket lives:** inside the `CindlClientApi`
  implementation. That is the desktop main process, the web page itself
  (same-origin with Hermes, already holding the session cookie, so the ticket
  adds no power it lacks), and the Android client outside the UI tree. UI code
  never sees a ticket, a `viewer_id` or raw RFB.
- **Contract (additive, in one change):**
  - `display.watch {}` returns `{ viewId, width, height }` under
    `computer.view`. It fails `unavailable` when the screen is stopped and
    never starts it.
  - `display.unwatch { viewId }`.
  - `display.input { viewId, events }` under `computer.control`, for pointer
    and key events. It is refused unless this device holds the lease (Hermes
    filters input as well).
  - Event `display.frame { viewId, rects }`, each rect being
    `{ x, y, width, height, rgba }`. The reducer ignores it; the viewer paints
    it.
  - Event `display.view-ended { viewId, reason }`, where reason is
    `control-taken`, `closed`, `stopped` or `error`.
- **Pull, not push.** The UI asks for the next update when it has painted.
  The client keeps only the newest pixels for each region, so a slow renderer
  (or IPC) never builds an unbounded queue. In the desktop app frames cross
  IPC as transferable typed arrays.
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
