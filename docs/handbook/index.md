# Cindl handbook

The canonical, versioned documentation for Cindl. It ships in the same
repository as the code so a behaviour change and its documentation are
reviewed together.

> Status: these pages are plain Markdown today. The static site build, link
> checks and coverage gates are being added by the docs/quality stream; until
> then, read the files directly.

## Start here

- [Architecture overview](architecture/overview.md): components, data flow and
  trust boundaries.
- [Decisions](architecture/decisions/): why the architecture is the way it is.
- [Threat model](security/threat-model.md): assets, adversaries, mitigations.
- [Acceptance matrix](project/acceptance-matrix.md): every requirement, its
  status and its evidence.

## Clients

- [Web](clients/web.md): requirements, demo, builds, security properties,
  keyboard.

## Reference

- [Hermes v0.22.5 transport](reference/hermes-v0.22.5.md): exactly which
  upstream routes, methods, requests and events Cindl uses.
- [Capabilities](reference/capabilities.md): what each capability means and how
  it is established.
- [Client operations](reference/client-operations.md): the full `CindlClientApi`.

## Contributing

Contributors and coding agents start with the repository's `AGENTS.md`; design
rules are in `DESIGN.md`.
