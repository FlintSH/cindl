# Cindl

Cindl (pronounced _sin-dəl_) is a calm, cross-device home for a self-hosted
[Hermes Agent](https://github.com/NousResearch/hermes-agent): one place to talk
to your always-on chief-of-staff agent, see what it is doing, answer what it
needs from you, and inspect who it is and what it can reach.

- **Web**: responsive client, also the renderer of the desktop app.
- **Desktop**: Electron shell with a hardened main/preload boundary.
- **Android**: native React Native app (not a WebView wrapper).

Hermes stays the brain. Cindl connects to an existing `hermes serve` backend over
its authenticated REST and JSON-RPC WebSocket transport. It adds no model, no
API keys and no hosted service.

## Status

Pre-release, under active development. What works today:

- Shared, tested foundations: versioned client contract, Hermes v0.22.5 adapter
  foundations (vendored upstream contract subset, PKCE, redaction), client
  state, design tokens.
- The web client UI against a **synthetic demo** (fictional data, always
  bannered): `pnpm --filter @cindl/web dev:demo`.

Not yet done: live Hermes transport, desktop and Android apps, CI, docs site.
The acceptance matrix in
[`docs/handbook/project/acceptance-matrix.md`](docs/handbook/project/acceptance-matrix.md)
tracks every requirement and its evidence.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter @cindl/web dev:demo   # http://127.0.0.1:5173
```

Requires Node 24.21 and pnpm 11.18. Contributors and coding agents start with
[`AGENTS.md`](AGENTS.md). Design rules live in [`DESIGN.md`](DESIGN.md);
architecture and decisions in [`docs/handbook`](docs/handbook/index.md).

## Licence

Cindl is MIT licensed, Copyright (c) 2026 Zachary Lowery. See [`LICENSE`](LICENSE).
Third-party material keeps its own licence and provenance, listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md): the Hermes contract excerpt
(MIT, Nous Research) and the bundled Instrument Sans and JetBrains Mono fonts
(SIL OFL 1.1).

Security reports: see [`SECURITY.md`](SECURITY.md).
