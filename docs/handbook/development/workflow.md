# Contributor and agent workflow

Cindl is built by people and coding agents working in parallel. The rules
below apply to both. The repository's
[`AGENTS.md`](https://github.com/FlintSH/cindl/blob/main/AGENTS.md) is the
short, binding version; this page explains how to follow it.

## Read before you change anything

1. Root `AGENTS.md`: invariants, commands, ownership and the definition of
   done.
2. The scoped `AGENTS.md` for each directory you will touch (for example
   `packages/hermes-adapter/AGENTS.md`, `docs/handbook/AGENTS.md`,
   `scripts/AGENTS.md`).
3. The handbook pages for that area, and the
   [architecture decisions](../architecture/decisions/) they cite.

If code and these documents disagree, fix one of them in the same change.

## One worktree per task

Work in a Git worktree that belongs to your task, created from an up-to-date
`main`:

```sh
git fetch origin
git worktree add ../cindl-<task> -b <branch> origin/main
cd ../cindl-<task>
pnpm install --frozen-lockfile
```

- Never edit another task's worktree, and never stop processes you did not
  start.
- The Git stash is shared by every worktree of a clone. Set work aside with a
  temporary commit on your branch instead of `git stash`.
- Local notes, hand-offs and scratch evidence go in `.agent-artifacts/`, which
  Git ignores. Never commit them.
- Run heavy commands through `scripts/with-lock.sh` on shared machines (see
  [Getting started](getting-started.md#shared-machines)).
- Local servers bind `127.0.0.1` only. Stop them when you are done.

## File ownership

Parallel work stays mergeable because every path has one owner.

| Paths                                                                                                                                                                                            | Owner                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Root files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, Prettier and Git config, `AGENTS.md`, `README.md`, `DESIGN.md`, `SECURITY.md`) | the coordinator                                       |
| `packages/contracts`                                                                                                                                                                             | the coordinator, through the contract-change protocol |
| Everything else                                                                                                                                                                                  | the stream whose task brief lists the path            |

A stream may:

- edit only the paths its brief lists;
- change `pnpm-lock.yaml` only through `pnpm add` or `pnpm install` filtered
  to its own package (`--filter <package>`);
- add a reviewed `allowBuilds` entry its own package needs, with the reason.

Shared configuration is extended, never edited: a package adds its own
`vitest.config.ts`, `tsconfig.json` and, if needed, an `eslint.config.mjs`
that spreads the root one. To change a file you do not own, write the exact
change you need in your hand-off or pull request and let its owner apply it.

## Contract changes

`packages/contracts` is the versioned client contract every client and the
adapter depend on. It is frozen per baseline.

1. Write the proposed diff and the reason in your hand-off or pull request
   description. Say whether it is breaking (a renamed or removed field, a
   narrowed type, a changed meaning).
2. The coordinator applies it on `main` and bumps `CONTRACTS_VERSION` for a
   breaking change. Streams then rebase.
3. In the same change, update what documents the contract:
   - run `node scripts/generate-docs-reference.mjs` so the
     [client operations](../reference/client-operations.md), event payload and
     [keyboard shortcut](../reference/keyboard-shortcuts.md) tables match;
   - describe a new event under [Events](../reference/events.md#events) and a
     new error code under [Error codes](../reference/events.md#error-codes);
   - add a new capability to [Capabilities](../reference/capabilities.md) with
     its Hermes source.

Never fork contract types inside an app. There is never a generic
passthrough operation ([ADR 0007](../architecture/decisions/0007-operation-surface.md)).

## Definition of done

A change is done when all of these hold and the evidence is in the pull
request or hand-off:

1. `pnpm verify` passes, plus any build the change touches.
2. Behaviour changes have tests that fail without the change.
3. Documentation impact is mapped for each persona (user, operator,
   integration) and the handbook pages are updated in the same commit, or the
   commit carries a `Docs-Impact` trailer that explains why not (see the
   [documentation workflow](docs.md)).
4. UI changes were exercised in a real browser at phone, tablet and desktop
   sizes with synthetic data, and the screenshots were reviewed for private
   data.
5. No capability is shown as working without a negotiated source.
6. Privacy review: no secrets, real hostnames, personal data or real
   screenshots in the diff. The privacy scan is a floor, not the review.
7. Known gaps are written down, not implied away.

## Gates

Run these before you push. CI runs all of them (see
[Quality gates](quality-gates.md) for details and fixes).

| Command                                                                      | Enforces                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                                                | Formatting, lint with zero warnings, type checks, unit tests, generated token CSS, then the privacy, licence and docs coverage gates, the gates' own tests, and both web builds with the build-output gate |
| `node scripts/check-privacy.mjs`                                             | No secrets, private addresses, personal data, build output or stray binaries in tracked files                                                                                                              |
| `node scripts/check-license.mjs`                                             | MIT licence and copyright line, private MIT packages, third-party notices and checksums                                                                                                                    |
| `node scripts/check-docs-coverage.mjs`                                       | The handbook documents every capability, operation, event, error, shortcut and pinned Hermes name                                                                                                          |
| `node scripts/check-docs-impact.mjs --base <commit>`                         | Each commit updates the docs for the code areas it changes, or explains why not                                                                                                                            |
| `pnpm --dir docs/handbook build`                                             | The handbook builds; links, anchors and assets resolve; nothing loads from another origin                                                                                                                  |
| `node --test "scripts/test/*.test.mjs"`                                      | The gates themselves reject bad input                                                                                                                                                                      |
| `pnpm --filter @cindl/web build`                                             | The production web bundle builds without demo data                                                                                                                                                         |
| `node scripts/check-dist.mjs --real apps/web/dist --demo apps/web/dist-demo` | Real builds hold no synthetic fixture records; demo builds carry the demo notice and label                                                                                                                 |
| `pnpm test:e2e`                                                              | The web client's end-to-end flows pass on the synthetic demo                                                                                                                                               |

## Commits and pull requests

- Imperative subject line ("Add the events reference"), a body that says why.
- No AI, co-author or "generated by" credit anywhere: commits, pull request
  titles, bodies or comments.
- One logical change per commit, with its documentation in the same commit.
- Open pull requests as drafts until the gates pass. Fill in every section of
  the template: what changed, documentation impact per persona, evidence with
  the exact commands and exit codes, screenshots of synthetic data for visible
  changes, and known gaps.
- Address review and CI feedback with real fixes. Do not disable or weaken a
  gate to get a green build; change its rules in a reviewed commit if they are
  wrong.

## Improvement loop

When a mistake repeats, fix its root cause: add a test, lint rule, schema check
or gate rule that catches it, then add at most a one-line lesson to the
nearest scoped `AGENTS.md`. Delete guidance that tooling now enforces or that
is no longer true. `AGENTS.md` stays short.
