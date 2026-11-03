# Contributing

Start with [`AGENTS.md`](AGENTS.md): it applies to people and coding agents
alike and contains the commands, invariants, ownership rules and definition of
done. Design rules are in [`DESIGN.md`](DESIGN.md); architecture, decisions and
the threat model are in [`docs/handbook`](docs/handbook/index.md).

Every change that alters observable behaviour, a default, a limit, a permission,
an error or a contract updates the relevant handbook page in the same commit.
If a change has no documentation impact, end the commit message with a trailer
the docs-impact gate can read, on one line:

```
Docs-Impact: none - <specific rationale, at least 20 characters>
```

Run `pnpm verify` before opening a pull request; it includes the privacy,
licence, docs coverage and build-output gates. CI also runs the per-commit
docs-impact check and the web end-to-end suite.

Only synthetic data belongs in this repository: fictional names, `example.test`
or `.invalid` hosts, no screenshots of real accounts.
