# Working on Cindl

Cindl is the cross-device home (web, Electron desktop, native Android) for one
owner's self-hosted **Hermes** agent. Hermes is the brain; Cindl never runs its
own model, keeps its own API keys or becomes a second chatbot. It is a
command-and-inspect surface: conversation first, with work, approvals,
identity, skills, memory, routines, connections and the agent's computer one
step away.

Read this file first, then only the scoped `AGENTS.md` and handbook pages for
the area you touch. Those are listed in the map below.

## Non-goals

- No hosted sync, analytics, auth broker, connector aggregator or paid service.
- No independent model/provider layer, no generic Hermes RPC/REST passthrough.
- No fake connected states, invented history or placeholder counters in the
  product. Missing capabilities and disconnected states are shown explicitly.
- No marketing hero, KPI card grids or decorative gradients (see `DESIGN.md`).
- No public listeners, tunnels, DNS or Hermes service changes. Hermes's dedicated
  API server and webhooks stay disabled.

## Repository map

| Path                      | What it is                                                                              | Scoped rules                        |
| ------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `packages/contracts`      | Versioned client contract: domain model, capabilities, events, client ops               | `packages/contracts/AGENTS.md`      |
| `packages/hermes-adapter` | Hermes v0.22.5 adapter: pinned upstream surface, PKCE, redaction; transport in progress | `packages/hermes-adapter/AGENTS.md` |
| `packages/client-core`    | Platform-agnostic store, reducer, selectors, diff, SHA-256, platform interfaces         | `packages/client-core/AGENTS.md`    |
| `packages/client-react`   | React bindings shared by web and Android                                                | `packages/client-core/AGENTS.md`    |
| `packages/tokens`         | Semantic design tokens, CSS generator, OFL fonts                                        | `DESIGN.md`                         |
| `packages/fixtures`       | SYNTHETIC scenario for tests and the labelled demo only                                 | `packages/fixtures/AGENTS.md`       |
| `apps/web`                | Responsive web client; also the Electron renderer                                       | `apps/web/AGENTS.md`                |
| `apps/desktop`            | Electron shell (main, preload, packaging)                                               | `apps/desktop/AGENTS.md`            |
| `apps/android`            | Native React Native / Expo Android app                                                  | `apps/android/AGENTS.md`            |
| `docs/handbook`           | Canonical handbook: architecture, decisions, security, reference                        | `docs/handbook/index.md`            |

Source-of-truth documents: `docs/handbook/architecture/overview.md`,
`docs/handbook/architecture/decisions/`, `docs/handbook/security/threat-model.md`,
`docs/handbook/reference/`, `docs/handbook/project/acceptance-matrix.md` and
`DESIGN.md`. If code and these disagree, fix one of them in the same change.

## Bootstrap and commands

Toolchain: Node `24.21.0` (`.node-version`), pnpm `11.18.0` (`packageManager`).

```sh
pnpm install --frozen-lockfile     # one lockfile for all runtime packages
pnpm verify                        # all of the below except docs impact, docs build and e2e
pnpm test                          # every package/app with a vitest.config.ts
pnpm typecheck                     # tsc per workspace package
pnpm lint                          # ESLint, zero warnings allowed
pnpm format                        # Prettier write
pnpm check:tokens                  # generated tokens.css/fonts.css are current
pnpm check:privacy                 # secrets, private hosts and personal data in tracked files
pnpm check:license                 # MIT line, package licences, third-party notices
pnpm check:docs                    # handbook covers the contract; generated tables current
pnpm check:dist                    # both web builds, then fixture markers and demo label
pnpm test:gates                    # tests of the gate scripts themselves
pnpm check:docs-impact --base <sha> # each commit updates its docs or says why not
pnpm docs:build                    # the handbook site (docs/handbook is its own pnpm project)
pnpm --filter @cindl/web dev:demo  # web UI on 127.0.0.1:5173 with the SYNTHETIC demo
pnpm --filter @cindl/web build     # production web build (no demo data)
pnpm test:e2e                      # web flow tests on the demo build (Playwright)
```

CI (`.github/workflows/ci.yml`, `docs.yml`) runs these gates and the web
end-to-end suite on GitHub-hosted runners, `desktop.yml` packages and
smoke-tests the desktop app (its build runs the output gates), and
`android.yml` builds both test APKs, checks each one
(`apps/android/scripts/check-apk.ts`) and runs the emulator steps; see
[`docs/handbook/development/quality-gates.md`](docs/handbook/development/quality-gates.md).

pnpm refuses dependency install scripts unless listed in `allowBuilds`
(`pnpm-workspace.yaml`) and refuses releases younger than its minimum release
age. Keep both protections: pick an older version instead of adding exclusions.

## Privacy and security invariants

1. **Public source, private runtime.** Never commit owner memories, SOUL
   content, chats, account or provider inventories, hostnames, IPs, tokens,
   cookies, auth traces, screenshots of real data or personal files. Examples
   use `example.test`/`.invalid` hosts and fictional names.
2. **Hermes transport only.** Clients reach an existing `hermes serve` backend
   (REST + JSON-RPC 2.0 over `/api/ws`). Never call the API-server or webhook
   platforms, never attach to discovered local ports or extract gateway
   credentials, never invent routes. Every upstream method Cindl uses is listed
   in `packages/hermes-adapter/src/upstream-surface.ts` and vendored at the
   pinned commit.
3. **Tokens stay in OS-backed stores.** Electron: main process only
   (`safeStorage`), never the renderer. Android: Keystore via secure storage.
   Web: Hermes's same-origin HttpOnly cookie only, nothing in browser storage.
   WS tickets and ticket subprotocols are secrets in diagnostics; redact with
   `@cindl/hermes-adapter` `redactText`/`redactValue`.
4. **Approvals are Hermes's, answered once.** Answer a server request once, by
   its Hermes request id, through a path Hermes acknowledges, only with a
   choice Hermes offered and Cindl permits (`once` or `deny`). Never send
   standing grants or the upstream `all` flag. Never reply to sudo, secret,
   vault or unknown prompts, not even with a decline or an error: the reply can
   become the stored secret or the password. Never present command approvals as
   a universal spending/sending policy engine.
5. **Fixtures are synthetic and labelled.** Synthetic records exist only in
   demo flavours (web `build:demo`, desktop and Android demo builds); real
   builds contain no fixture records (`SYNTHETIC_FIXTURE_MARKERS`, checked by
   `pnpm check:dist` for web). The demo label (`SYNTHETIC_DEMO_LABEL`/`SYNTHETIC_DEMO_NOTICE`) stays in
   every renderer and shows whenever `link.demo` is true; never compile it out.
   A test double is never a silent production fallback (ADR 0011).
6. **Owner edits are explicit and versioned.** SOUL/skill writes go through
   edit, diff review and confirmation, and carry the SHA-256 version that was
   read. Hermes v0.22.5 has no server-side compare-and-swap: say so. Memory
   entries are edited only through Hermes's fingerprinted learning-node ids
   (refuse positional ids for writes); never generic filesystem routes or memory
   reset as a workaround. No arbitrary path reads or writes.
7. **Agent output is untrusted.** No raw HTML, no automatic remote image loads,
   links open externally with their destination visible.
8. **Computer control is scoped and leased.** Only the agent-owned screen of a
   Hermes profile; never start/stop/install a screen as a side effect of
   viewing (an open view does count as use, so the screen's idle stop waits);
   never log or record secret entry.
9. **Honest capabilities.** Every feature is gated on a negotiated capability
   with a reason and source; `unknown` is never rendered as working.

## Working conventions

- TypeScript strict, erasable syntax only (no enums/namespaces/parameter
  properties), explicit `.ts`/`.tsx` relative imports so Node 24, Vite, Metro
  and esbuild all run the same source without a build step.
- UI calls only `CindlClientApi` (`packages/contracts/src/ops.ts`); state comes
  from events reduced in `client-core`. No UI writes to the store directly.
- Styling uses semantic tokens (`var(--color-*)`, `var(--space-*)`). No raw
  colours outside `packages/tokens`.
- Keyboard shortcuts live in `apps/web/src/shortcuts.ts` only.
- Tests sit next to code under `test/`. Test behaviour, not mocks of itself.
- Commits: imperative subject, no AI/co-author/generated-by credit anywhere.

## Parallel work and file ownership

Work in task-owned Git worktrees. `main` only moves by merging reviewed work;
day-to-day commits, coordinator ones included, go on a branch (check
`git branch --show-current` before committing). One coordinator owns root files
(`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
`eslint.config.mjs`, `vitest.config.ts`, Prettier/Git config, this file,
`README.md`, `DESIGN.md`, `SECURITY.md`) and `packages/contracts`. A stream may:

- edit only the paths it owns (listed in its task brief);
- change `pnpm-lock.yaml` only through `pnpm add/install --filter <its package>`;
- add a reviewed `allowBuilds` entry needed by its own package, explaining why.

Shared configs are extended locally: a package adds its own
`vitest.config.ts`, `tsconfig.json` and (if needed) `eslint.config.mjs` that
spreads the root one. It never edits the root file.

### Contract-change protocol

`packages/contracts` is frozen per baseline. To change it, write the proposed
diff and rationale in your hand-off (or PR description); the coordinator
applies it on `main`, bumps `CONTRACTS_VERSION` for breaking changes, and
streams rebase. Never fork contract types inside an app.

## Definition of done

A change is done when all of these hold, and the evidence is in the PR or
hand-off:

1. Each commit passes its affected checks: the touched packages' tests,
   typecheck and lint, and `pnpm docs:build` when it touches `docs/handbook`
   (verify does not render the handbook). Each candidate handed off or merged
   passes `pnpm verify` and every stream-specific build it touches once, at its
   exact SHA. Reuse unchanged evidence by showing the diff does not reach it.
   Native, security and state-authority changes still need current runtime or
   independent proof.
2. Behaviour changes have tests that would fail without the change: a positive
   control and the change's own meaningful mutations, with survivors
   classified. Do not re-run inherited mutation campaigns for unrelated code.
3. Docs impact is mapped (user, operator, integration personas) and the
   handbook pages are updated in the same commit, or the commit explains why
   there is no doc impact.
4. UI changes were exercised in a real browser at phone, tablet and desktop
   sizes with synthetic data, with screenshots reviewed for private data.
5. No new capability is shown as working without a negotiated source.
6. Privacy review: no secrets, real hostnames, personal data or real
   screenshots in the diff.
7. Known gaps are written down, not implied away.

## Improvement loop

When a mistake repeats, fix its root cause, add a test, lint rule, schema
check or helper that catches it, then add at most a one-line lesson to the
nearest scoped `AGENTS.md`. Delete guidance that the tooling now enforces or
that is no longer true. This file stays short.
