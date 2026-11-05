# 0014 Talk's workspace after T3 Code

**Status:** Accepted (owner direction, 2026-11-05). Web and desktop (shared
renderer): built and tested in a browser on the synthetic demo. Android:
partly; see Consequences.

**Context.** The owner named T3 Code the best agent interface they use and
asked Cindl to take its best features, with heavier inspiration than the
papercut pass that preceded this. T3 Code was read, not run, at
`pingdotgg/t3code` commit `a21d788`: its thread sidebar
(`components/Sidebar.tsx`, `components/sidebar/`), work log
(`components/chat/MessagesTimeline.logic.ts`, `TimelineWorkGroupRows.tsx`,
`WorkLog.tsx`), composer (`ComposerSurface.tsx`, `ComposerPrimaryActions.tsx`,
`composerPromptHistory.ts`), pending-input panel
(`ComposerPendingUserInputPanel.tsx`) and command palette
(`CommandPaletteContent.tsx`).

An earlier left sidebar was shelved (`flintsh/shelved-left-sidebar`): it
replaced the four-destination spine, and the owner had asked for T3 Code's
right panel, not its navigation ([ADR 0013](0013-conversation-panel.md)).
This decision keeps the spine, the bottom navigation and the panel as they
are.

**Decision.** Talk takes five things from T3 Code:

- **A conversation list** beside the conversation, on wide screens (1280px
  and up) only, inside Talk. It holds the main conversation (pinned), what
  needs the owner, then the rest by recency. A row's right-hand slot shows
  a status worth a glance ("Needs you", "2 need you", "Working") in place of
  how long ago it changed ("5m", "3h", "Jun 2"). The arrow keys move through
  it without opening anything, Enter opens, F2 or a double click renames when
  Hermes offers renaming, and typing searches. `Ctrl/⌘ B` hides and shows it
  (remembered on the device); `Ctrl/⌘ J` goes to its search while it is
  shown, and to the switcher otherwise. Narrower windows, tablets and phones
  keep the switcher.
- **A work log:** two or more consecutive steps in a reply fold into one line
  that says how many and how long they took ("2 steps · 1m 24s") once all of
  them are done. The line stays open while Hermes works, waits on the owner
  or has a failure, and while one of its steps is selected; the owner's own
  open or closed choice wins for the session. The step that is running has a
  slow sweep across its label.
- **A composer in two parts:** the text on top, a bar beneath it in the same
  box with what sending does now (or the keys) on the left and one primary
  button on the right. That button is Stop while Hermes works and the box is
  empty, and Send as soon as there is text, so Stop and Send never compete.
  Its presses never take focus from the text. ArrowUp in an empty box brings
  back what the owner sent in this conversation; ArrowDown goes forward.
- **Questions docked above the composer:** on Talk, with room (768px wide and
  640px tall or more), a question set waits right where the owner types, one
  question at a time with a counter, number keys on its choices, and a short
  pause before a single-choice pick moves on. It is the same card as before,
  with the same answer-once lock, drafts and refusals; only its layout
  changed. Approvals stay in the conversation, beside the step they hold.
  Work shows every card in full.
- **A grouped command palette:** Go to, Actions, Conversations and Theme,
  each with a heading and its rows' icons; the most recent conversations
  when nothing is typed; a leading `>` for commands only; the keys along its
  foot.

**Not taken, on purpose.**

- Standing grants ("Always allow this session"): Cindl sends only `once` or
  `deny` (AGENTS.md invariant 4).
- A secret-entry card: Cindl never answers secret, sudo or vault prompts.
- Remote loads (images, favicons) and drafts in browser storage.
- The composer as the questions' answer box: a question's own answer field
  keeps answers apart from messages to Hermes.
- Shortcuts that answer: number keys only pick choices in the docked card,
  never send, and never act on a single quick question.
- A resizable list and panel, hover menus, archive and snooze: Hermes v0.22.5
  has no archive or snooze, and resizing can come later.

**Consequences.**

- Wide windows show four columns: the spine, the list, the conversation and
  the panel. At exactly 1280px with the panel open the conversation is about
  544px wide; either side can be hidden (`Ctrl/⌘ B`, `Ctrl/⌘ .`). The desktop
  app opens at 1360px.
- Steps addressed by title (tests, the panel's Show) are inside a folded line
  when finished; the selected step's line stays open.
- Android takes the work log, the live timer and the one-slot Stop and Send;
  it keeps its conversation sheet and its question cards in the
  conversation, since a phone has no room for a list or a dock.
