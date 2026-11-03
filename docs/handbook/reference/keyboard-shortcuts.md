# Keyboard shortcuts

These shortcuts work in the web client, which is also the desktop app's
renderer. Press <kbd>?</kbd> in the app to see the same list in the shortcuts
dialog. Every shortcut is defined once, in `apps/web/src/shortcuts.ts`; the
table below is generated from that file and the docs coverage gate fails if
they differ.

<!-- BEGIN GENERATED: keyboard-shortcuts. Source: apps/web/src/shortcuts.ts. Regenerate with node scripts/generate-docs-reference.mjs -->

| Action                          | Windows and Linux                                 | macOS                                      | While typing | ID                    |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------ | ------------ | --------------------- |
| Open the command palette        | <kbd>Ctrl</kbd> + <kbd>K</kbd>                    | <kbd>⌘</kbd> + <kbd>K</kbd>                | yes          | `palette`             |
| Switch conversation             | <kbd>Ctrl</kbd> + <kbd>J</kbd>                    | <kbd>⌘</kbd> + <kbd>J</kbd>                | yes          | `switch-conversation` |
| Start a side conversation       | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>O</kbd> | <kbd>⌘</kbd> + <kbd>⇧</kbd> + <kbd>O</kbd> | yes          | `new-side`            |
| Show or hide the working margin | <kbd>Ctrl</kbd> + <kbd>.</kbd>                    | <kbd>⌘</kbd> + <kbd>.</kbd>                | yes          | `toggle-margin`       |
| Go to Talk                      | <kbd>Alt</kbd> + <kbd>1</kbd>                     | <kbd>⌥</kbd> + <kbd>1</kbd>                | yes          | `go-talk`             |
| Go to Work                      | <kbd>Alt</kbd> + <kbd>2</kbd>                     | <kbd>⌥</kbd> + <kbd>2</kbd>                | yes          | `go-work`             |
| Go to Library                   | <kbd>Alt</kbd> + <kbd>3</kbd>                     | <kbd>⌥</kbd> + <kbd>3</kbd>                | yes          | `go-library`          |
| Go to Agent                     | <kbd>Alt</kbd> + <kbd>4</kbd>                     | <kbd>⌥</kbd> + <kbd>4</kbd>                | yes          | `go-agent`            |
| Focus the message box           | <kbd>/</kbd>                                      | <kbd>/</kbd>                               | no           | `focus-composer`      |
| Show keyboard shortcuts         | <kbd>?</kbd>                                      | <kbd>?</kbd>                               | no           | `help`                |

<!-- END GENERATED: keyboard-shortcuts -->

- **While typing** says whether the shortcut also works while the focus is in a
  text field, such as the message box. The others are ignored while you type,
  so <kbd>/</kbd> and <kbd>?</kbd> can still be typed into a message.
- <kbd>?</kbd> is <kbd>Shift</kbd> + <kbd>/</kbd> on a US layout. The app
  reacts to the <kbd>?</kbd> character itself, so use whichever keys type it
  on your layout.
- The number shortcuts match the physical number keys, so they also work on
  layouts where those keys type other characters.

To add or change a shortcut, edit `apps/web/src/shortcuts.ts` (never a
component), then run `node scripts/generate-docs-reference.mjs` and commit
the regenerated table with the change.
