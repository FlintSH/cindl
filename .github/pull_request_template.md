## What changed

What the change does and why, in a few sentences. Name the code areas it
touches and any effect on existing setups.

## Documentation impact

Map the impact for each persona and link the handbook pages updated in the same
commits. Write "none" with the reason when a persona is unaffected.

- **User** (clients, keyboard shortcuts, `DESIGN.md`):
- **Operator** (operations, security, pending decisions, `SECURITY.md`):
- **Integration** (reference, architecture and decisions):
- **Contributor** (development pages, `AGENTS.md`, `CONTRIBUTING.md`):

Commits without documentation changes carry a
`Docs-Impact: none - <specific rationale>` trailer.

## Evidence

Commands you ran and their exit codes, for example:

| Command                                              | Exit code |
| ---------------------------------------------------- | --------- |
| `pnpm verify`                                        |           |
| `node scripts/check-privacy.mjs`                     |           |
| `node scripts/check-license.mjs`                     |           |
| `node scripts/check-docs-coverage.mjs`               |           |
| `node scripts/check-docs-impact.mjs --base <commit>` |           |
| `node --test "scripts/test/*.test.mjs"`              |           |
| `pnpm --dir docs/handbook build`                     |           |

Add any build the change touches (web, desktop, Android) and what you checked
by hand.

## Screenshots

For visible changes: phone, tablet and desktop sizes, both themes, synthetic
data only, with the demo banner visible. Check every image for real names,
hosts, tokens and personal data before attaching it.

## Known gaps

What is not done, not validated (for example against a live Hermes), or
deliberately left for a follow-up.
