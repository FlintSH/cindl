# Cindl handbook

The canonical, versioned documentation for Cindl. It ships in the same
repository as the code so a behaviour change and its documentation are
reviewed together, in the same commit. Every page states the commit it was
built from, and whether the build included uncommitted changes.

The pages say plainly what is built, what is only designed, and what has not
been validated against a live Hermes yet; the
[acceptance matrix](project/acceptance-matrix.md) tracks each requirement and
its evidence.

## Start here

- [Getting started](development/getting-started.md): bootstrap a checkout and
  run every check, with the exact commands.
- [Architecture overview](architecture/overview.md): components, data flow and
  trust boundaries.
- [Decisions](architecture/decisions/): why the architecture is the way it is.
- [Threat model](security/threat-model.md): assets, adversaries, mitigations.

## Develop

- [Contributor and agent workflow](development/workflow.md): worktrees, file
  ownership, contract changes and the definition of done.
- [Quality gates](development/quality-gates.md): what each gate enforces and
  how to fix a failure.
- [Testing](development/testing.md) and the
  [documentation workflow](development/docs.md).

## Operate

- [Running Cindl](operations/index.md): what can be deployed today (nothing
  yet) and how each client will reach Hermes.
- [Pending owner decisions](project/pending-decisions.md): choices that block
  deployment, live validation and releases.

## Clients

- [Web](clients/web.md): requirements, demo, builds, security properties,
  keyboard.
- [Desktop](clients/desktop.md): the Electron app, its two flavours, sign-in,
  token storage and security model.
- [Android](clients/android.md): the native app, demo and real builds, sign-in,
  the agent's screen, CI builds and what only a device can prove.

## Reference

- [Client operations](reference/client-operations.md): the full
  `CindlClientApi`, generated from the contract.
- [Server requests](reference/server-requests.md): approvals, clarify sets and
  prompts Cindl does not answer, from open to closed.
- [Events and errors](reference/events.md): every `CindlEvent` and error code.
- [Capabilities](reference/capabilities.md): what each capability means and how
  it is established.
- [Hermes v0.22.5 transport](reference/hermes-v0.22.5.md): exactly which
  upstream routes, methods, requests and events Cindl uses.
- [Keyboard shortcuts](reference/keyboard-shortcuts.md).

## Contributing

Contributors and coding agents start with the repository's
[`AGENTS.md`](https://github.com/FlintSH/cindl/blob/main/AGENTS.md); design
rules are in [`DESIGN.md`](https://github.com/FlintSH/cindl/blob/main/DESIGN.md).
