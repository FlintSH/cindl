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

`pnpm verify` runs most gates in one command; each also has its own alias in
the root `package.json`.

| Gate                    | Command                                                | Where CI runs it                                                                              |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Verify                  | `pnpm verify`                                          | `ci.yml`, Verify and repository gates                                                         |
| Privacy and secret scan | `pnpm check:privacy`                                   | In `pnpm verify`, and as its own `ci.yml` step                                                |
| Licence check           | `pnpm check:license`                                   | In `pnpm verify`, and as its own `ci.yml` step                                                |
| Docs coverage           | `pnpm check:docs` (with the generated-table check)     | In `pnpm verify`; `docs.yml` runs the coverage check alone                                    |
| Gate tests              | `pnpm test:gates`                                      | In `pnpm verify`, and as its own `ci.yml` step                                                |
| Web builds and outputs  | `pnpm check:dist` (both web builds, then `check-dist`) | In `pnpm verify`                                                                              |
| Docs impact             | `pnpm check:docs-impact --base <commit>`               | `ci.yml`, on pull requests and pushes                                                         |
| Web end-to-end          | `pnpm test:e2e`                                        | `ci.yml`, Web end-to-end on the synthetic demo, plus editor focus on a test-only harness page |
| Docs build and links    | `pnpm docs:build`                                      | `docs.yml`, at `/` and at `/cindl/`                                                           |

Both workflows run on every pull request and on pushes to `main`, with
read-only permissions and actions pinned to full commit SHAs. `docs.yml`
uploads the built handbook as a workflow artifact (`handbook-<commit>`, kept
for 14 days). Nothing is deployed or published anywhere.

## Verify

`pnpm verify` runs Prettier in check mode, ESLint with zero warnings allowed,
`tsc` for every workspace package, every Vitest project, the check that the
generated token CSS matches `packages/tokens/src`, then the privacy scan, the
licence check, docs coverage with the generated tables, the gates' own tests,
and both web builds followed by the build-output gate. Each gate also has its
own `pnpm check:*` alias in the root `package.json`. Fix formatting with
`pnpm format`. See [Testing](testing.md) for the test layout.

The gates themselves are linted by `scripts/eslint.config.mjs`, which spreads
the root config and lifts one rule: computed dynamic imports, which the gates
need to load workspace sources from `--root` in their tests. Scripts never
ship in a client; every other rule applies to them unchanged.

The root config also encodes Cindl's invariants, each with a case in
`apps/web/test/lint-rules.test.ts`. ESLint replaces a rule's options per
matching block, so each scope lists its complete set. Every root block is
anchored to the repository root (`basePath`), so the scopes below name the
same files from a package config that spreads the root one, such as
`apps/desktop/eslint.config.mjs`. The global-object rules see through casts
(`as`, `satisfies`, `!`), optional chains and `(0, window)`.

- **Every file:** no raw HTML; no fixture code outside tests and the fixtures
  package, including relative `node_modules` paths, repeated slashes,
  `import.meta.glob` and fixture asset URLs; no browser storage or cookies by
  name, computed key, destructuring or `Reflect`.
- **Shipped sources** (`apps/*/src`, `packages/*/src`, and the Android app's
  `index.ts` and `modules/` bridges): also no computed
  `new URL(…, import.meta.url)`, no aliases of global objects or
  `document.defaultView`, no `Reflect` or property-descriptor calls on them,
  and no `navigator.storage` through another object. Scripts and tests may
  stub globals.
- **Browser-facing sources** (`apps/web/src`, the Android app's sources,
  entry and native-module bridges, the desktop preload and the modules it
  bundles from `apps/desktop/src/shared`, and the browser packages): also no
  alias of a global object made by assignment, and no
  storage or cookie property through any object. Node code keeps legitimate
  `cookie` fields, such as HTTP headers, and Electron main names its
  BrowserWindow `window`.
- **`apps/web/src/platform/client.ts`** and
  **`apps/android/src/platform/client.ts`** (the demo switches): one literal
  `import('@cindl/fixtures/scenario')`, and every other rule. The Android
  app's own config adds its checks (raw colours, DOM globals, storage only in
  `src/platform`) on top of these scopes.
- **`apps/web/src/platform/preferences.ts`:** `localStorage` only; every other
  storage API stays off limits.

## Privacy and secret scan

`node scripts/check-privacy.mjs` reads every tracked file. The rules are in
`scripts/lib/privacy.mjs`. It reports:

| Finding                      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials                  | PEM private key blocks, JSON Web Tokens, GitHub, AWS, OpenAI and Anthropic, Google, Slack, GitLab, Hugging Face, Stripe, npm and Telegram token formats. Thresholds match the product's own redactor in `packages/hermes-adapter/src/redact.ts`.                                                                                                                                                                                                                                                                                                                                                                  |
| Credentials from diagnostics | WebSocket ticket values, `Authorization` header values, secret query parameters (`ticket`, Hermes's screen-viewer `display_ticket`, `token`, access and refresh tokens, `code`, `code_verifier`) and secret key/value pairs such as passwords and API keys. A value counts when it has letters and digits and is not a placeholder (`<token>`, `${TOKEN}`, `[redacted]`, `YOUR_KEY`). In documents and configuration any such value of 8 or more characters fails; in code, where tests keep short synthetic vectors and types name these keys, only ticket, header and query values of 24 or more characters do. |
| Network addresses            | Any IPv4 or IPv6 address except loopback, unspecified, broadcast, the documentation ranges (RFC 5737, RFC 3849) and the Android emulator's fixed addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Email addresses              | Any address outside the reserved example domains (`example.com`, `example.test`, `.example`, `.test`, `.invalid`). A lockfile's `deprecated:` notices are npm registry text from package authors and are exempt.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Private hostnames            | Names under `.ts.net` anywhere; names under `.local`, `.lan`, `.internal`, `.home`, `.corp` and similar in documents and configuration, and in code where they appear as a URL host, `user@host` or `host:port`. File names such as `.env.local` and expression paths such as `github.event.repository.private` are not hosts.                                                                                                                                                                                                                                                                                    |
| Credentials in URLs          | A user name and password written before the host of a URL, unless the host is loopback or an example domain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The copyright holder's name  | Allowed only in `LICENSE`, `THIRD_PARTY_NOTICES.md` and the licence section of `README.md`. The name is read from `LICENSE`, so the scanner itself names nobody.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Build output and local state | Anything under `dist/`, `build/`, `coverage/`, `node_modules/`, the handbook build output or cache, `.agent-artifacts/`, generated native projects, logs, source maps and app packages.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Credential-bearing files     | `.env` files (except `.env.example`), keys and certificates, keystores, `auth.json`, cookie and browser storage-state files, HAR captures, SQLite databases, signing properties.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Binaries and large files     | Binary files outside the allowed asset paths, and files over 256 KiB unless an allowed path sets its own limit: fonts in `packages/tokens/fonts` (512 KiB), the vendored Hermes contract subset (1 MiB), lockfiles (4 MiB), reviewed screenshots under the handbook's `public/screenshots/` (1 MiB, subfolders allowed), recordings under `public/media/` (8 MiB), and app icons and images under an app's `public`, `assets` or `resources` folder (1 MiB).                                                                                                                                                      |
| Symbolic links               | A tracked link is scanned as the path it stores, never as the file it points to, and fails if it points outside the repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
- the key combinations in the Keyboard table of the
  [web client page](../clients/web.md) to be exactly those in
  `apps/web/src/shortcuts.ts`, plus the message box's own `Enter` and
  `Shift Enter` (ranges such as `Alt 1` to `Alt 4` are expanded);
- every method, server request and notification in
  `packages/hermes-adapter/src/upstream-surface.ts`, and every REST endpoint in
  `packages/hermes-adapter/src/compat.ts`, in the
  [Hermes v0.22.5 reference](../reference/hermes-v0.22.5.md);
- no placeholder text (`TODO`, `TBD`, `FIXME`, `coming soon`) outside code in
  any handbook page;
- every Markdown link in the repository, every repository path named in a
  tracked file (code comments included), every `docs: <page>` mention and every
  link to this repository's files on GitHub to point at something that exists. A root
  link in a handbook page (`/screenshots/...`) may also name a file under
  `docs/handbook/public/`, which VitePress serves at the site root.
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

## Build outputs

`node scripts/check-dist.mjs` checks build outputs by flavour, as
[ADR 0011](../architecture/decisions/0011-fixtures.md) defines them. Pass each
output with its flavour; a path may be a folder or a single packaged file, such
as a desktop `app.asar`:

```sh
node scripts/check-dist.mjs --real apps/web/dist --demo apps/web/dist-demo
```

`pnpm check:dist` builds both web flavours and then runs this command, and
`pnpm verify` includes it.

- **Real flavours** (web `build`; later the desktop real package and the
  Android release bundle) fail if any file contains a synthetic fixture record:
  a string from `SYNTHETIC_FIXTURE_MARKERS` in `@cindl/fixtures/markers`, whose
  own test proves each marker still occurs in the scenario. A source map that
  lists a fixtures source fails too. The demo label copy is allowed: every
  renderer keeps it, so a demo flavour built on a production renderer can
  never show synthetic data unlabelled.
- **Demo flavours** (web `build:demo`; later the desktop demo package and the
  Android demo build) fail unless a shipped file contains both
  `SYNTHETIC_DEMO_NOTICE` and `SYNTHETIC_DEMO_LABEL` from `@cindl/contracts`.
  Source maps do not count: they embed the original sources, so they hold the
  label even when the bundle has lost it.
- **Every output** fails if a source map names an absolute path, or if any file
  contains the build machine's checkout or home directory path.

Every file in an output is searched as bytes, so bundles, Hermes bytecode and
`app.asar` archives are covered. Compressed containers (`.apk`, `.aab`, `.zip`
and similar) are rejected: pass the extracted output, because a byte search
cannot see inside them. An output that is missing or empty fails, and a
`dist-demo` folder passed as `--real` is reported as a mistake.

Desktop and Android outputs join this gate by passing their packaged outputs
with the flavour they are built as.

## Gate tests

`node --test "scripts/test/*.test.mjs"` runs the gates against fixture
repositories and build folders created in a temporary directory. Each gate has
tests for the input it must reject. Secret-shaped test values are assembled at
runtime, so the privacy scan never sees a literal one.
