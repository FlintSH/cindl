# Quality gates

Every gate is a Node 24 script in `scripts/` with no dependencies beyond the
repository's own tooling. Each one prints every problem it finds, exits
non-zero on any problem, and fails when its inputs are missing instead of
passing with nothing to check. Each gate has tests in `scripts/test/` that
prove it rejects bad input.

Gates check structure: that something is present, current and resolvable.
They cannot judge whether prose is complete or true. The review that the
[definition of done](workflow.md#definition-of-done) asks for still applies.

## Where each gate runs

| Gate                    | Command                                              | CI workflow and job                   |
| ----------------------- | ---------------------------------------------------- | ------------------------------------- |
| Verify                  | `pnpm verify`                                        | `ci.yml`, Verify and repository gates |
| Privacy and secret scan | `node scripts/check-privacy.mjs`                     | `ci.yml`                              |
| Licence check           | `node scripts/check-license.mjs`                     | `ci.yml`                              |
| Gate tests              | `node --test "scripts/test/*.test.mjs"`              | `ci.yml`                              |
| Docs impact             | `node scripts/check-docs-impact.mjs --base <commit>` | `ci.yml` (pull requests and pushes)   |
| Production web build    | `pnpm --filter @cindl/web build`                     | `ci.yml`                              |
| Production output       | `node scripts/check-dist.mjs apps/web/dist`          | `ci.yml`, after the web build         |
| Docs coverage           | `node scripts/check-docs-coverage.mjs`               | `docs.yml`                            |
| Docs build and links    | `pnpm --dir docs/handbook build`                     | `docs.yml`, at `/` and at `/cindl/`   |

Both workflows run on every pull request and on pushes to `main`, with
read-only permissions and actions pinned to full commit SHAs. `docs.yml`
uploads the built handbook as a workflow artifact (`handbook-<commit>`, kept
for 14 days). Nothing is deployed or published anywhere.

## Verify

`pnpm verify` runs Prettier in check mode, ESLint with zero warnings allowed,
`tsc` for every workspace package, every Vitest project, and the check that the
generated token CSS matches `packages/tokens/src`. Fix formatting with
`pnpm format`. See [Testing](testing.md) for the test layout.

The gates themselves are linted by `scripts/eslint.config.mjs`, which spreads
the root config and lifts one rule: computed dynamic imports, which the gates
need to load workspace sources from `--root` in their tests. Scripts never
ship in a client; every other rule applies to them unchanged.

## Privacy and secret scan

`node scripts/check-privacy.mjs` reads every tracked file. The rules are in
`scripts/lib/privacy.mjs`. It reports:

| Finding                      | Rule                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Credentials                  | PEM private key blocks, JSON Web Tokens, GitHub, AWS, OpenAI and Anthropic, Google, Slack, GitLab, Hugging Face, Stripe, npm and Telegram token formats. Thresholds match the product's own redactor in `packages/hermes-adapter/src/redact.ts`. |
| Network addresses            | Any IPv4 or IPv6 address except loopback, unspecified, broadcast, the documentation ranges (RFC 5737, RFC 3849) and the Android emulator's fixed addresses.                                                                                      |
| Email addresses              | Any address outside the reserved example domains (`example.com`, `example.test`, `.example`, `.test`, `.invalid`).                                                                                                                               |
| Private hostnames            | Names under `.ts.net` anywhere; names under `.local`, `.lan`, `.internal`, `.home`, `.corp` and similar in documents and configuration, and in code where they appear as a URL host, `user@host` or `host:port`.                                 |
| Credentials in URLs          | A user name and password written before the host of a URL, unless the host is loopback or an example domain.                                                                                                                                     |
| The copyright holder's name  | Allowed only in `LICENSE`, `THIRD_PARTY_NOTICES.md` and the licence section of `README.md`. The name is read from `LICENSE`, so the scanner itself names nobody.                                                                                 |
| Build output and local state | Anything under `dist/`, `build/`, `coverage/`, `node_modules/`, the handbook build output or cache, `.agent-artifacts/`, generated native projects, logs, source maps and app packages.                                                          |
| Credential-bearing files     | `.env` files (except `.env.example`), keys and certificates, keystores, `auth.json`, cookie and browser storage-state files, HAR captures, SQLite databases, signing properties.                                                                 |
| Binaries and large files     | Binary files outside the allowed asset paths, and files over 256 KiB unless an allowed path sets a higher limit (fonts, the vendored Hermes contract subset, lockfiles, reviewed screenshots and recordings, app icons).                         |

Findings are masked in the output so the log does not repeat what it found.

To fix a finding, replace the value instead of hiding it: use `127.0.0.1`,
`192.0.2.10` or `2001:db8::1` for addresses, `name@example.test` for email,
`hermes.example.test` or a `.invalid` name for hosts. A test that needs a
secret-shaped value assembles it at runtime, as
`packages/hermes-adapter/test/redact.test.ts` does, so no literal secret is
ever committed. An allowlist entry is a reviewed change to
`scripts/lib/privacy.mjs` with its reason; there are no inline exemptions.

The scanner cannot know your own hostnames or the names of people around you.
List them, one per line, in a file outside the repository and pass it in:

```sh
CINDL_PRIVACY_MARKERS=~/.config/cindl/private-markers.txt node scripts/check-privacy.mjs
node scripts/check-privacy.mjs --markers ~/.config/cindl/private-markers.txt
```

Matches are reported by line number only. Add `--include-untracked` to scan new
files before you commit them.

## Licence check

`node scripts/check-license.mjs` (rules in `scripts/lib/license.mjs`) requires:

- `LICENSE` is the MIT licence text, character for character, with the pinned
  copyright line. The line is pinned by its SHA-256, and the licence section of
  `README.md` must state the same line and say MIT.
- Every `package.json` is `"private": true` and declares `"license": "MIT"`,
  or an SPDX `AND` expression when the package ships third-party material under
  another licence. `@cindl/tokens` bundles OFL fonts, so it declares
  `(MIT AND OFL-1.1)`. The expected value comes from `THIRD_PARTY_NOTICES.md`.
- Each row of `THIRD_PARTY_NOTICES.md` names material that exists, a source,
  and a licence file that exists and contains that licence's text.
- Every file in a third-party directory (`upstream/`, `vendor/`, `fonts/` and
  similar) is covered by a notice.
- Every `SHA256SUMS` file matches the files it lists and lists every file
  beside it, so a replaced font fails the build.

## Docs coverage

`node scripts/check-docs-coverage.mjs` (rules in `scripts/lib/coverage.mjs`)
loads the TypeScript source directly, so run `pnpm install` first. It requires:

- a row in [Capabilities](../reference/capabilities.md) for every id in
  `capabilityIds`, and no row for an id that no longer exists;
- the generated tables in [Client operations](../reference/client-operations.md),
  [Events and errors](../reference/events.md) and
  [Keyboard shortcuts](../reference/keyboard-shortcuts.md) to match the source
  exactly (regenerate them with `node scripts/generate-docs-reference.mjs`);
- a described section for every `CindlEvent` type and a table row for every
  error code in [Events and errors](../reference/events.md);
- every method, server request and notification in
  `packages/hermes-adapter/src/upstream-surface.ts`, and every REST endpoint in
  `packages/hermes-adapter/src/compat.ts`, in the
  [Hermes v0.22.5 reference](../reference/hermes-v0.22.5.md);
- no placeholder text (`TODO`, `TBD`, `FIXME`, `coming soon`) outside code in
  any handbook page;
- every Markdown link in the repository, every repository path named in a
  tracked file (code comments included), every `docs: <page>` mention and every
  link to this repository's files on GitHub to point at something that exists.
  Paths that Git ignores, such as build output, may be named. Tests and the
  synthetic fixtures are not checked for paths: they name files in the
  throwaway repositories they build and in the fictional demo workspace.

## Docs build and links

`pnpm --dir docs/handbook build` runs the VitePress build, which fails on a
dead link between pages, then `scripts/check-docs-build.mjs` on the output. That
check requires:

- every local link, anchor, image, script, stylesheet and font to resolve
  within the site, and within its base path;
- nothing to load from another origin: no font CDN, external script,
  stylesheet, image or frame;
- links to this repository's files on GitHub to name files that exist;
- every page to be linked from another page (the sidebar counts);
- `build-info.json` to be valid, and every page to carry the same commit in its
  `cindl:commit` meta tag and its build stamp.

CI builds twice, once with `DOCS_BASE=/cindl/` to prove the site works under a
sub-path and once at `/` for the uploaded artifact.

## Docs impact

`node scripts/check-docs-impact.mjs --base <commit>` checks each commit after
`<commit>`, one at a time: a commit that changes a code area must change that
area's documentation, or carry a `Docs-Impact: none - <rationale>` trailer. A
later commit never covers an earlier one. The areas, the trailer rules and how
to fix a rejected commit are in the [documentation workflow](docs.md).

## Production output

`node scripts/check-dist.mjs apps/web/dist` runs after a production build. It
fails if the output contains synthetic demo data, if a source map lists a
fixtures source or an absolute path, or if any file contains the build
machine's checkout or home directory path. The demo markers are every
distinctive string literal in `packages/fixtures/src` that appears in no
production source file, plus a short list in `scripts/lib/dist.mjs` that must
still occur in the fixtures. Never run it on `apps/web/dist-demo`, which is
meant to contain the scenario; it reports that folder as a demo build.

Desktop and Android outputs join this gate by passing their output folders to
the same command.

## Gate tests

`node --test "scripts/test/*.test.mjs"` runs the gates against fixture
repositories and build folders created in a temporary directory. Each gate has
tests for the input it must reject. Secret-shaped test values are assembled at
runtime, so the privacy scan never sees a literal one.
