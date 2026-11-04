# Testing

Tests prove behaviour, not that a mock returns what the test told it to.
Every behaviour change ships with a test that fails without it.

## Unit tests (Vitest)

`pnpm test` runs Vitest across every workspace package and app that has its
own `vitest.config.ts`; the root config lists `packages/*/vitest.config.ts` and
`apps/*/vitest.config.ts` as projects, so a new package joins by adding its
config, never by editing the root one.

- Tests live next to the code under `test/` and are named `*.test.ts` or
  `*.test.tsx`.
- Each project is named after its package (`contracts`, `client-core`,
  `client-react`, `hermes-adapter`, `fixtures`, `tokens`, `web`). The web
  project runs in jsdom.

```sh
pnpm test                                                  # every project once
pnpm test:watch                                            # re-run on change
pnpm exec vitest run --project client-core                 # one project
pnpm exec vitest run packages/client-core/test/state.test.ts   # one file
```

## What to test where

| Area                      | Test                                                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`      | Rules a schema enforces: confirmations, versions, offered choices, no passthrough operations                                                                                                                                      |
| `packages/client-core`    | One reducer test for each event rule, including replayed and out-of-order events                                                                                                                                                  |
| `packages/hermes-adapter` | Wire knowledge against the vendored upstream contract; redaction of every secret format; PKCE and redirect rules                                                                                                                  |
| `packages/tokens`         | Contrast of every shipped colour pairing in both themes                                                                                                                                                                           |
| `packages/fixtures`       | That the synthetic scenario behaves like the contract says (conflicts, unsupported capabilities, answer-once)                                                                                                                     |
| `apps/web`                | Components through `CindlClientApi` with the synthetic scenario, never by writing to the store; stylesheet rules (scroll containers are positioned, colours come from tokens); lint rules for fixture, storage and adapter access |
| `scripts/`                | Each gate against fixture repositories it must reject (see below)                                                                                                                                                                 |

The adapter's integration tests are to run against a fake Hermes server whose
frames are validated against the vendored upstream schemas. That server is not
built yet; see the [acceptance matrix](../project/acceptance-matrix.md).

## Synthetic data only

- Use `@cindl/fixtures` for scenarios. It is fictional, always reports
  `link.demo = true`, and lint forbids importing it from production code.
- Synthetic records exist only in demo flavours, which always show the demo
  notice; real builds contain none
  ([ADR 0011](../architecture/decisions/0011-fixtures.md), checked by the
  [build-outputs gate](quality-gates.md#build-outputs)).
- Hosts are `example.test` or `.invalid`; addresses are loopback or from the
  documentation ranges; people and companies are invented.
- Never paste real data into a test, even redacted.
- Secret-shaped values are assembled at runtime so no literal secret is
  committed and the [privacy scan](quality-gates.md#privacy-and-secret-scan)
  stays meaningful:

```ts
// Synthetic, assembled at runtime; not a real credential.
const fake = (...parts: string[]) => parts.join('')
const token = fake('gh', 'p_', 'a'.repeat(28))
```

## Gate tests

The repository gates in `scripts/` are tested with Node's built-in test runner.
Each test builds a throwaway Git repository or build folder in the system
temporary directory, runs the gate as a separate process, and checks its exit
code and message.

```sh
node --test "scripts/test/*.test.mjs"
node --test scripts/test/check-privacy.test.mjs   # one gate
```

When you add a rule to a gate, add a test with input the rule must reject, and
check that the test fails without the rule.

## End-to-end tests (Playwright)

The web client has a Playwright suite in `apps/web/e2e`. It builds the
synthetic demo (`build:demo`), serves it with the production CSP on
`127.0.0.1:4173`, and drives it in Chromium with one worker. It fails on any
console error, page error or CSP violation, and a layout spec checks that the
document itself never scrolls at phone, tablet and desktop sizes. It exercises
the real UI and client state, not a live Hermes.

```sh
pnpm --filter @cindl/web exec playwright install chromium   # first run only
pnpm test:e2e
CINDL_E2E_CHANNEL=chrome pnpm test:e2e                      # an installed Chrome instead
```

CI runs the same suite with Playwright's bundled Chromium in the
`Web end-to-end on the synthetic demo` job and keeps the traces of a failed
run as a workflow artifact for seven days. The [web client page](../clients/web.md#tests)
lists the optional screenshot capture.

## Browser checks

UI changes are exercised in a real browser before review, with the synthetic
demo (`pnpm --filter @cindl/web dev:demo`), at phone (390x844 and 360x800),
tablet (768x1024) and desktop (1280x800 and 1440x1000) sizes, in both themes,
with keyboard and touch. Screenshots attached to a pull request show only
synthetic data with the demo banner visible, and are checked for private data
first.

Run browsers headless on shared machines, at most one browser worker at a
time, and stop every local server you start.
