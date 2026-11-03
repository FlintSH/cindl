# Pending owner decisions

These choices belong to the owner. Until each is made, the work it blocks
stays blocked and the [acceptance matrix](acceptance-matrix.md) says so. When a
decision is made, record it here (or in a new
[architecture decision](../architecture/decisions/)) in the same change that
acts on it, and update the affected pages.

## Same-origin web mount

**Decide:** where and how the web client is served from the same origin as
`hermes serve`, or whether the web client stays a demo and the desktop
renderer only.

**Why it matters.** The web client signs in with Hermes's own session cookie,
so it can only reach Hermes from the `hermes serve` origin. Hermes's Origin,
Host and CORS checks stay as they are and Cindl never asks for wildcard CORS
([ADR 0002](../architecture/decisions/0002-direct-hermes-transport.md)). Until
this is decided, the production web build cannot connect to anything.

**Already fixed:** no new public listener, tunnel, DNS record or change to the
Hermes service as a side effect of Cindl; no tokens in browser storage.

**Blocks:** a working web client against Hermes; the operator instructions on
[Running Cindl](../operations/index.md).

## Live validation run

**Decide:** whether, when and against which Hermes profile a contributor may
exercise Cindl against the owner's authenticated instance, and what evidence
may be kept.

**Why it matters.** The transport has been read from the pinned Hermes v0.22.5
source, not run against a live server. Sign-in, WebSocket tickets, the
handshake (including whether one session authority spans every surface),
reconnect and replay, answer-once approvals and versioned SOUL.md edits all
need a real run before they are called working.

**Already fixed:** evidence stays redacted and private; no conversation
content, hostnames, tokens or screenshots of real data enter this repository.
Passwords and second factors are entered only on Hermes's own pages.

**Blocks:** the live-transport and session-authority rows of the acceptance
matrix.

## Release and signing policy

**Decide:** how releases are versioned and published, and how each client is
signed: Android release keys and store distribution, desktop code signing and
notarisation, where release artifacts live, and who may publish them.

**Why it matters.** Until this is decided, Android test builds are signed with
a throwaway key made for each CI run
([ADR 0008](../architecture/decisions/0008-android.md)) and CI artifacts are
for review, not for installation by others.

**Blocks:** releases of every client; release notes and an upgrade path on
[Running Cindl](../operations/index.md).

## Handbook hosting

**Decide:** whether the handbook is published (for example with GitHub Pages)
and from which branch or release.

**Why it matters.** Publishing needs a repository setting and owner scope. CI
builds the site under a sub-path to keep that option open, and uploads it as a
workflow artifact only.

**Blocks:** a public handbook URL. Until then, read the pages in the repository
or download the artifact.

## Private security reporting

**Decide:** whether to enable GitHub's private vulnerability reporting, which
is a repository setting.

**Why it matters.** Reporters need a private path that does not depend on an
unconfigured setting. Until the owner decides, follow
[`SECURITY.md`](https://github.com/FlintSH/cindl/blob/main/SECURITY.md); no
repository or account setting is changed on the owner's behalf.

## Decided

### Android SDK licence and device validation

**Decided:** Google's Android SDK licence approved for Cindl APK builds and
emulator tests on existing GitHub build runners only; test APKs built in CI on
PR #4, none on `main` yet ([ADR 0008](../architecture/decisions/0008-android.md)).

The approval covers only the SDK packages those builds need, each checked
before acceptance. It does not cover development machines, the Hermes host or
anyone's phone, other terms, paid services, Play Store enrollment, or
production signing or release; builds stay debug-signed. Android sign-in,
including surviving backgrounding and process death while the system browser
is open ([ADR 0003](../architecture/decisions/0003-authentication.md)), is
therefore checked on an emulator in CI, not on a device. The Android stream
owns the APK build, and an APK or emulator run counts only with its CI run and
artifact as evidence.
