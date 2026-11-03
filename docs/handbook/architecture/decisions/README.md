# Architecture decisions

Short records of decisions that shape Cindl. Each has a status; superseded
records stay for history and link to their replacement. Changing a decision
means a new record or an edit to its status in the same change as the code.

| #    | Decision                                                                       | Status                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | [One TypeScript pnpm monorepo](0001-monorepo.md)                               | Accepted                                                                                                                                |
| 0002 | [Direct to `hermes serve`, no Cindl server](0002-direct-hermes-transport.md)   | Accepted                                                                                                                                |
| 0003 | [Per-platform authentication](0003-authentication.md)                          | Accepted (live validation pending)                                                                                                      |
| 0004 | [Capability honesty](0004-capabilities.md)                                     | Accepted                                                                                                                                |
| 0005 | [Server requests answered once, conservative choices](0005-server-requests.md) | Accepted (contract v4; answer path and live validation pending)                                                                         |
| 0006 | [Owner edits: diff, confirm, version check](0006-owner-edits.md)               | Accepted                                                                                                                                |
| 0007 | [Narrow operation surface, no passthrough](0007-operation-surface.md)          | Accepted                                                                                                                                |
| 0008 | [Native Android with Expo / React Native](0008-android.md)                     | Accepted (Android SDK licence: APK builds and emulator tests on GitHub-hosted runners only; no APK on `main` yet)                       |
| 0009 | [Electron with the web renderer and a hardened main process](0009-electron.md) | Accepted (implemented; live sign-in waits on the transport)                                                                             |
| 0010 | [Shared tokens and the Conversation Desk](0010-design-system.md)               | Accepted                                                                                                                                |
| 0011 | [Synthetic fixtures for tests and a labelled demo only](0011-fixtures.md)      | Accepted                                                                                                                                |
| 0012 | [Computer view: the RFB stream stays inside the client](0012-computer-view.md) | Proposed (direct-client transport and the desktop screen socket built and tested against the fake; Android and web not wired; not live) |
