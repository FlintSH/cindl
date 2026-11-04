# 0013 The working margin as the conversation's panel

**Status:** Accepted (owner direction, 2026-11-03). Web: built and tested in
a browser on the synthetic demo; the desktop app shares that renderer but has
not been run with it. Android: to follow, in its working-margin sheet.

**Context.** The owner asked Cindl to take the paradigm of the right-hand
panel inside a conversation in T3 Code: a panel beside the conversation that
switches between tools for that conversation while the conversation stays
primary. T3 Code was read, not run, at `pingdotgg/t3code` commit `c3c15f7`
(in its web app: `rightPanelStore.ts`, `RightPanelTabs.tsx`,
`ChatRightPanel.tsx`, `RightPanelSheet.tsx`, `rightPanelLayout.ts` and
`PanelLayoutControls.tsx`):

- Each thread has its own panel: tools open as tabs, one shows at a time, and
  an add menu lists the tools with the reason any is unavailable.
- The panel sits beside the chat, or slides in from the right as a sheet at
  980px and below. A pressed toggle in the chat header shows or hides it.
- Tabs the agent opens never take focus, and give way to what the user did.
- Its tools are mostly for coding (diff, files, terminal, pull requests); its
  browser and device tools show another machine's screen beside the chat.

Cindl already has the **working margin**: a column beside the conversation,
or a sheet, showing the selected step's evidence or what the conversation
waits on. That is where this belongs. The owner's request is not about the
left navigation, which stays as it is.

**Decision.**

- The working margin becomes the conversation's panel, with a small fixed set
  of tools, switched by a tab strip at its top (`role="tablist"`, arrow
  keys):
  - **Waiting**: what this conversation waits on, with the count on the tab.
    Each request's Show reveals its card in the conversation; the actionable
    card never appears twice.
  - **Step**: the selected step's evidence (tool, status, redacted input and
    result previews). Selecting a step in the conversation opens the margin on
    Step; selecting it again, or "Clear the step", empties Step and leaves it
    chosen.
  - **Computer**: the agent's screen, live, beside the conversation, with the
    same watch and take-control rules as Work (ADR 0012). Only with
    `computer.view` usable; otherwise it says why. Leaving the tool, the
    margin or the conversation closes its view, and gives control back if
    this device took it there (as leaving Work does), a take-control still on
    its way included, so Hermes's input is not left paused behind a screen
    nobody is watching. With the link down the hand-back cannot reach Hermes:
    the client then keeps the owner's control, as a dropped link does, rather
    than give the screen to the agent unseen. A conversation left on
    Computer opens the view again whenever it is shown, so while it is on
    screen the agent's screen is watched and does not idle (ADR 0012).
- Switching is deliberate. Nothing changes the tool by itself: counts change,
  the tool does not. Each conversation keeps its own tool and selected step,
  with its unsent message and reading position, in memory until the session
  ends.
- Presentation is unchanged: a 400px column on wide windows, remembered open
  or closed; a modal sheet below 1280px, which opens with focus on the chosen
  tool's tab and returns focus to what opened it. The header toggle and
  `Mod+.` show or hide it; closing the column puts focus on that toggle.
- **Not taken:** owner-added or reordered tabs, an add menu (the set is
  small), dragging, resizing (later), coding tools, side chats, and any
  widget or plugin framework. The navigation (spine, bottom bar, destinations
  and the history popover) does not change for this.
- **Android** gets the same tools in its working-margin sheet, linked to the
  conversation: not a navigation drawer, and not a WebView.

**Consequences.** The margin's header becomes the tab strip and its close
button. The Work page keeps its own view of the computer; the margin's is the
same component. Flow tests, screenshots, `DESIGN.md` and the web client page
change with it.
