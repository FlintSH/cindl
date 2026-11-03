# Cindl design system

One design across web, desktop and Android. Values live in `@cindl/tokens`
(`packages/tokens/src`); this document explains how to use them. If a value here
and the tokens package disagree, the tokens package wins and this file is fixed.

## Posture: quiet heat, precise instrument

Cindl is a cinder-inspired identity: warm, low, steady. It should feel like a
well-made instrument, not a dashboard. Warm mineral neutrals in light, warm
graphite in dark, one restrained ember accent used for intent (primary action,
"needs you", focus), never for decoration.

Never: marketing heroes, KPI or stat-card grids, decorative gradients, glass
effects, pillowy tiles (radius tops out at 12px), emoji decoration, fake
counters, copied brand assets.

## Information architecture: the Conversation Desk

Four destinations. Conversation is the anchor; everything else is one step away.

| Destination | Holds                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| **Talk**    | The main ongoing conversation and side conversations, with inline work and decisions.     |
| **Work**    | Needs you (approvals, questions), running work, scheduled routines, the agent's computer. |
| **Library** | Skills, memory, artifacts.                                                                |
| **Agent**   | Identity (SOUL.md), connections, runtime and capabilities, this device, appearance.       |

Talk has no permanent thread column. A searchable history popover (title
button, `Mod+J`) switches conversations; the command palette (`Mod+K`) reaches
everything. The **working margin** is contextual: it shows the step you
selected (evidence), or what the conversation is waiting on. It replaces
content instead of adding panes.

## Layout

| Width                 | Layout                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `< 768px` (compact)   | Single column, bottom navigation, margin as a bottom sheet, safe-area insets respected. |
| `768–1279px` (medium) | 72px navigation spine; margin overlays from the right.                                  |
| `>= 1280px` (wide)    | Spine, conversation at a 720px reading measure, margin as a 400px column.               |

Breakpoints are literal in media queries: 768 and 1280. The working margin
opens as a sheet over the conversation below 1280px, so closing it returns to
the same scroll position. Restoring scroll positions across destination
switches is planned.

## Typography

- **Instrument Sans** (UI and reading), **JetBrains Mono** (commands, code,
  tool previews). Both SIL OFL 1.1, bundled locally in `packages/tokens/fonts`;
  no font CDN.
- Text styles: `caption 12/16`, `label 13/18`, `ui 14/20`, `body 16/26`
  (conversation text), `title 18/26`, `heading 22/30`, `display 28/36`,
  `code 13/20`. Web uses rem so browser zoom and user font size scale text;
  Android applies the OS font scale to the same numbers.
- Section labels: `label` size, 600 weight, uppercase, 0.04em tracking, tertiary
  colour. Used sparingly.

## Colour

Use semantic roles only (`--color-<role>` on web, `nativeColors()` on Android):
`canvas`, `surface`, `surface-raised`, `surface-sunken`, `border`,
`border-strong`, `text`, `text-secondary`, `text-tertiary`, `accent`,
`accent-hover`, `on-accent`, `accent-text`, `accent-subtle`, `focus`, the
`success/warning/danger/info` pairs and `scrim`/`selection`.

Every shipped foreground/background pairing is tested (`packages/tokens/test`):
body text at least 7:1, all other text at least 4.5:1, focus rings and input
borders at least 3:1, in both themes. Add a pairing to `requiredPairs` before
using it.

## Shape, space, depth, motion

- 4px grid (`--space-*`). Radii: 4, 6, 8, 12; `pill` only for chips and dots.
- Depth comes from surfaces and 1px borders; shadows are soft and reserved for
  raised controls (composer, decision cards) and overlays.
- Motion is brief (120/180/240ms, `--ease-standard`) and functional: overlays
  fade in, nothing bounces. `prefers-reduced-motion` collapses durations to 0
  and stops spinners.

## Components

- **Messages.** Owner messages are compact right-aligned bubbles
  (`surface-sunken`). Hermes replies are full-width reading blocks with the
  agent name and time. Unprompted output (routines, proactive messages) shows
  its provenance ("From a routine").
- **Tool activity.** One quiet line per step: status icon, title, duration.
  Selecting it opens redacted evidence in the margin.
- **Decision cards.** Approvals and questions are structured, deliberate cards:
  what will run (verbatim, as Hermes redacted it), why, and only the offered
  choices Cindl may send. Primary action is ember; there is no "approve all".
  Standing grants are named as withheld, not hidden.
- **Composer.** Always available while connected; sending while Hermes works is
  allowed (Hermes queues, steers or redirects). Enter sends, Shift+Enter adds a
  line. When not connected it says so instead of silently queueing.
- **Unavailable features.** Rendered with `RequireCapability`: name, state and
  the concrete reason. Never an empty shell that looks like working software.
- **Rows, not cards.** Work, Library and Agent use bordered row lists.

## Accessibility

- Visible focus ring (`--color-focus`, 2px, offset 2px) on every interactive
  element. Keyboard reaches everything; shortcuts are in `apps/web/src/shortcuts.ts`
  and listed in the shortcuts dialog (`?`).
- Touch targets at least 44px on coarse pointers, 48dp on Android (its
  platform minimum); 32px minimum on fine pointers.
- Landmarks (`nav`, `main`, `aside`), named controls, `role="status"` for the
  presence line, `role="alert"` for errors, native `<dialog>` for overlays.
- Text reflows at 320px and 200% zoom without horizontal scrolling of prose.
- Android: system back closes sheets and overlays before navigating; IME
  insets keep the composer visible; TalkBack labels match web labels.

## Platform mapping

- **Web/Electron**: same renderer. Electron adds native menus, window state and
  native file dialogs; it never changes the visual language.
- **Android**: native components with the same tokens, bottom navigation for the
  four destinations, sheets for the margin, platform back and share behaviour.

## Copy

Specific, calm and brief. Say what happened and what the owner can do. No
exclamation marks, no hype, no em dashes in UI copy. Name limitations plainly
("Hermes v0.22.5 cannot revoke tokens it already issued").
