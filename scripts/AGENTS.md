# scripts

Repository gates and docs generators, run directly with `node scripts/...` by
people and CI. Read `docs/handbook/development/quality-gates.md` first.

- Node 24 `.mjs` with no dependencies beyond the repository's own tooling
  (Prettier, TypeScript). Never add a runtime dependency to a shipped package
  for a gate.
- A CLI file only parses arguments and reports; rules live in `lib/` so they
  can be read and tested.
- Fail closed: missing inputs, unreadable sources or an empty result are
  errors, never a pass. Print every problem, then exit non-zero.
- Every rule has a test in `test/` with input it must reject. Build fixture
  repositories in a temporary directory; assemble secret-shaped values at
  runtime so the privacy scan never sees a literal one.
- Never print a secret or private value: mask findings.
- Allowlists live in `lib/` with their reason. No inline exemption comments.
- Changing what a gate enforces is a contributor-facing change: update
  `docs/handbook/development/` in the same commit.
