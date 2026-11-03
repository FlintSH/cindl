# packages/fixtures

SYNTHETIC data only. Every name, company, file, command and account is
fictional and must stay obviously so (fictional studio, `.invalid` /
`example.test` hosts, "(fixture)" labels).

- Never paste real data, even redacted, and never derive fixtures from a real
  account.
- The scenario client must always report `link.demo = true`.
- Only tests, e2e suites and `apps/web/src/platform/client.ts` (behind
  `VITE_CINDL_DEMO=1`) may import this package; ESLint enforces it.
- Keep capability states realistic for Hermes v0.22.5 (unsupported stays
  unsupported) so demos never imply features that do not exist.
- Mirror Hermes's identifiers exactly (memory ids count across both stores,
  agent notes first): a demo that numbers differently hides client bugs.
