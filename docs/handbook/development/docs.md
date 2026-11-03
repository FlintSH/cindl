# Documentation workflow

Documentation is part of the change. A commit that changes what someone can
do, a default, a limit, a permission, an error or the contract updates the
handbook pages that describe it, in the same commit. A later commit never
covers an earlier one.

## Map the impact by persona

Before you write code, decide who is affected and which pages they read.

| Persona     | Who                                                   | Where they read                                                                                                                                    |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| User        | The owner using Cindl on web, desktop or Android      | Client pages, [keyboard shortcuts](../reference/keyboard-shortcuts.md), `DESIGN.md`                                                                |
| Operator    | Whoever runs Hermes and installs the clients          | [Operations](../operations/index.md), [security](../security/threat-model.md), [pending decisions](../project/pending-decisions.md), `SECURITY.md` |
| Integration | Anyone building against the contract or the transport | [Reference](../reference/client-operations.md) and [architecture](../architecture/overview.md) pages, including decisions                          |
| Contributor | People and agents changing Cindl itself               | These development pages, `AGENTS.md` files and `CONTRIBUTING.md`                                                                                   |

A change can affect every persona. The checks below look at file paths only:
you remain responsible for complete and true content, including behaviour no
path rule can see.

## The per-commit docs-impact gate

`node scripts/check-docs-impact.mjs --base <commit>` checks every commit after
`<commit>` that is not a merge. CI runs it on pull requests (from the base of
the pull request) and on pushes to `main` (from the previous tip). Commits made
before the gate was added are not checked.

For each commit, every changed path belongs to the first matching area below.
For each area it touches, the same commit must change a file in that area's
documentation:

| Code area               | Paths                                                                 | Documentation that must change             |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| Client contract         | `packages/contracts/src`, `packages/contracts/scripts`                | Integration                                |
| Hermes transport        | `packages/hermes-adapter/src`, `scripts` and `upstream`               | Integration or operator                    |
| Client state            | `packages/client-core/src`, `packages/client-react/src`               | Integration or user                        |
| Design tokens and fonts | `packages/tokens/src`, `scripts`, `fonts` and `generated`             | User, `THIRD_PARTY_NOTICES.md` or ADR 0010 |
| Synthetic fixtures      | `packages/fixtures/src`                                               | Contributor or ADR 0011                    |
| Web client              | `apps/web`                                                            | User                                       |
| Desktop client          | `apps/desktop`                                                        | The desktop client page or operator        |
| Android client          | `apps/android`                                                        | The Android client page or operator        |
| Handbook site           | `docs/handbook/.vitepress`, the handbook's package files and lockfile | Contributor                                |
| Tooling and CI          | `scripts`, `.github`, root files, package-level config files          | Contributor                                |
| Anything else           | A path no rule above owns                                             | Any handbook page or root guide            |

Never counted as code: Markdown files, handbook media under `public/`, tests
(`test/`, `e2e/`, `*.test.*`), issue and pull request templates, Dependabot
configuration, `LICENSE` and Git housekeeping files (`.gitignore`,
`.gitattributes`, `.editorconfig`, `.prettierignore`). The exact patterns are
in `scripts/lib/docs-impact.mjs`.

### When nothing a reader relies on changed

Some code changes need no documentation: a refactor with identical behaviour,
a test-only helper, a dependency patch. Say why in a trailer, the last
paragraph of the commit message:

```text
Extract the frame parser into its own module

Behaviour is unchanged; the parser tests moved with it.

Docs-Impact: none - parser moved to frames.ts; same frames, events and errors
```

The trailer is accepted only as `Docs-Impact: none - <rationale>`, with one
trailer per commit, and a rationale of at least 20 characters that says what
changed and why no page describes it. These are rejected:

| Trailer                                              | Why                                 |
| ---------------------------------------------------- | ----------------------------------- |
| `Docs-Impact: n/a`, `Docs-Impact: none`              | Not `none - <rationale>`            |
| `Docs-Impact: none - trivial`                        | Shorter than 20 characters          |
| `Docs-Impact: none - no user-visible changes needed` | Generic: names nothing that changed |

A trailer is not a way around documentation: reviewers check that the
rationale is true. Commits from Dependabot that change only package manifests,
lockfiles and workflow files pass without one.

### Fixing a rejected commit

Add the missing page changes or the trailer to the commit itself; a new commit
on top does not fix an earlier one.

```sh
git commit --amend --trailer "Docs-Impact: none - <rationale>"   # latest commit
git commit --fixup <commit>                                      # an earlier commit,
git -c sequence.editor=: rebase -i --autosquash <base>           # then fold the fix-up in
```

If the pull request is squash-merged, keep the trailer in the final commit
message: the push to `main` is checked again.

## Generated reference pages

Three tables are generated from source and must not be edited by hand. They sit
between `BEGIN GENERATED` and `END GENERATED` comments:

| Page                                                       | Source                             |
| ---------------------------------------------------------- | ---------------------------------- |
| [Client operations](../reference/client-operations.md)     | `packages/contracts/src/ops.ts`    |
| [Events and errors](../reference/events.md), event summary | `packages/contracts/src/events.ts` |
| [Keyboard shortcuts](../reference/keyboard-shortcuts.md)   | `apps/web/src/shortcuts.ts`        |

```sh
node scripts/generate-docs-reference.mjs           # rewrite the tables
node scripts/generate-docs-reference.mjs --check   # fail if a table is stale
```

The generator formats the pages with the repository's Prettier settings, so
`pnpm format:check` accepts the result. Everything outside the markers is
written by hand, including each event's description and each error code's
meaning, and the [coverage gate](quality-gates.md#docs-coverage) checks it is
complete.

## The handbook site

The handbook is a [VitePress](https://vitepress.dev) 1.6 site in
`docs/handbook`, built as its own pnpm project with its own lockfile so docs
tooling never enters the runtime workspace. Commands are in
[Getting started](getting-started.md#build-the-handbook).

- **Pages and navigation.** Every Markdown page under `docs/handbook` is a
  page, except `AGENTS.md`. The sidebar in `.vitepress/sidebar.mjs` takes each
  page's label from its first heading, and the build fails when it lists a
  page that does not exist or a page exists that it does not list. Client
  pages under `clients/` and decision records under `architecture/decisions/`
  are added to it automatically.
- **Links.** Link to other pages with relative Markdown links to the `.md`
  file, for example `[Capabilities](../reference/capabilities.md)`. Link to
  repository files outside the handbook with their GitHub URL on `main`; the
  checks verify that the file exists.
- **Provenance.** Each page shows the commit it was built from, whether the
  working tree had uncommitted changes, and the build time, all read from Git
  at build time. The same data is in `build-info.json` at the site root. There
  is no hardcoded version or branch. A build from a source archive without Git
  says the commit is unknown, or uses `GITHUB_SHA` in CI.
- **Look.** The theme maps VitePress onto Cindl's semantic tokens and bundled
  fonts from `packages/tokens`, using only the colour pairings the token tests
  check for contrast. The site loads nothing from another origin: no font CDN,
  external scripts or analytics, and search runs locally in the browser.
- **Local servers.** `dev` and `preview` listen on `127.0.0.1` only. VitePress
  1.6.4's own preview server ignores its host option and listens on every
  interface, so `preview` runs `.vitepress/preview.mjs`, a small static server
  that serves only the built site.
- **Hosting.** None. CI uploads the built site as an artifact for review.
  Publishing it anywhere is an [owner decision](../project/pending-decisions.md).

## Writing rules

- Write for the person doing the task: real labels, exact commands, actual
  defaults and limits, what happens when something fails.
- Say what is not built or not validated. Never describe a capability as
  working without a negotiated source.
- Examples are synthetic: invented names, `example.test` or `.invalid` hosts,
  documentation IP ranges, no real screenshots. Screenshots and recordings of
  the synthetic demo go in the handbook's `public/screenshots/` and
  `public/media/` folders after you check them for private data.
- No placeholder pages: text such as `TODO` or `TBD` outside code fails the
  coverage gate.
- Match the existing voice: specific, calm, brief, British spelling, no hype
  and no em dashes.

## Who owns which pages

| Pages                                                                                         | Owner                           |
| --------------------------------------------------------------------------------------------- | ------------------------------- |
| Architecture decisions, threat model, acceptance matrix, the web client page                  | The coordinator                 |
| The desktop and Android client pages                                                          | The desktop and Android streams |
| Content of the Hermes v0.22.5 reference and capabilities pages                                | The transport stream            |
| Handbook tooling, development pages, operations, pending decisions, the other reference pages | The docs and quality stream     |

Anyone may fix a broken link or a typo; content changes to a page you do not
own go to its owner, as with code.
