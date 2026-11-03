# Getting started

Bootstrap a checkout and run every check the CI runs. All commands run from
the repository root unless a step says otherwise.

## Prerequisites

- **Node.js 24.21.0**, the version in `.node-version`. The root `package.json`
  accepts `>=24.21.0 <25` and pnpm refuses other versions (`engineStrict`).
- **pnpm 11.18.0**, the version in the root `packageManager` field. Install it
  with any method from the pnpm documentation, for example
  `npm install --global pnpm@11.18.0`.
- **Git**, with full history if you want to run the docs-impact gate locally.

Check the versions before you install anything:

```sh
node --version   # v24.21.0
pnpm --version   # 11.18.0
```

## Bootstrap and verify

```sh
git clone https://github.com/FlintSH/cindl.git
cd cindl
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm install --frozen-lockfile` installs the runtime workspace (`packages/*`
and `apps/*`) from the single root lockfile and fails if the lockfile is out of
date. pnpm only runs dependency install scripts listed under `allowBuilds` in
`pnpm-workspace.yaml`, and refuses package versions younger than its minimum
release age (one day by default). Keep both protections: choose an older
version rather than adding an exclusion.

`pnpm verify` runs, in order: `format:check` (Prettier), `lint` (ESLint with
zero warnings), `typecheck` (`tsc` per workspace package), `test` (Vitest
across every package and app with a `vitest.config.ts`) and `check:tokens`
(the generated token CSS matches its source).

## Run the web client on synthetic data

```sh
pnpm --filter @cindl/web dev:demo   # http://127.0.0.1:5173
```

The demo uses the fictional scenario in `@cindl/fixtures` and always shows the
synthetic-data banner. Stop the server with <kbd>Ctrl</kbd> + <kbd>C</kbd>. A
production build, which never contains the demo data, is:

```sh
pnpm --filter @cindl/web build      # output in apps/web/dist
```

The end-to-end suite drives the demo build in Chromium; see
[Testing](testing.md#end-to-end-tests-playwright) for the first-run browser
install:

```sh
pnpm test:e2e
```

## Run the repository gates

These run in CI on every pull request and push to `main`. Each fails with a
list of problems and exits non-zero; none of them passes by skipping work. See
[Quality gates](quality-gates.md) for what each one checks and how to fix a
failure.

```sh
node scripts/check-privacy.mjs          # secrets, private addresses, personal data
node scripts/check-license.mjs          # MIT licence, package manifests, notices
node scripts/check-docs-coverage.mjs    # the handbook covers the contract and code
node --test "scripts/test/*.test.mjs"   # the gates' own tests
node scripts/check-docs-impact.mjs --base origin/main   # per-commit docs impact
```

The coverage gate imports the contract source, so run it after
`pnpm install`. The docs-impact gate needs the base commit in your clone; in a
shallow clone, fetch more history first.

## Build the handbook

The handbook is a separate pnpm project with its own lockfile, so docs tooling
never enters the runtime workspace.

```sh
pnpm --dir docs/handbook install --frozen-lockfile
pnpm --dir docs/handbook build      # VitePress build, then the link and asset check
pnpm --dir docs/handbook preview    # http://127.0.0.1:4174
pnpm --dir docs/handbook dev        # http://127.0.0.1:5174, reloads as you edit
```

The build output in `docs/handbook/.vitepress/dist` and the cache beside it are
ignored by Git. Set `DOCS_BASE=/cindl/` (leading and trailing slash) to build
for a sub-path; the link check uses the same value.

## Shared machines

On a development VM shared by several agents, run heavy commands (installs,
builds, `pnpm verify`) through the lock wrapper so they take turns:

```sh
scripts/with-lock.sh pnpm verify
scripts/with-lock.sh pnpm --dir docs/handbook build
```

It uses `flock` on `/tmp/cindl-heavy-build.lock` (override with
`CINDL_HEAVY_LOCK`) and runs the command unlocked, with a notice, where `flock`
is not installed.

## Next steps

Read [`AGENTS.md`](https://github.com/FlintSH/cindl/blob/main/AGENTS.md), then
the [contributor and agent workflow](workflow.md) before your first change.
