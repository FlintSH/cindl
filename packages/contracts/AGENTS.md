# packages/contracts

The versioned client contract. Every client and the adapter depend on it, so it
has one owner (the coordinator) and changes only through the contract-change
protocol in the root `AGENTS.md`.

- Breaking change (renamed/removed field, narrowed type, changed meaning): bump
  `CONTRACTS_VERSION` and update every consumer in the same change.
- Every new operation needs: a schema for args and result, `mutates`, the
  gating capability, a summary, a test in `test/contracts.test.ts` if it has
  rules (confirmations, versions), and a row in
  `docs/handbook/reference/client-operations.md`.
- New capability: add it to `capabilityIds`, document it in
  `docs/handbook/reference/capabilities.md` with its Hermes source.
- No passthrough operations, ever (ADR 0007).
- Zod 4: use `z.partialRecord` for maps that may be incomplete.
