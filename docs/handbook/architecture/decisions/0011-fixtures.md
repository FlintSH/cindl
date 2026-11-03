# 0011 Synthetic fixtures for tests and labelled demo flavours only

**Status:** Accepted (labelling contract revised for packaged demos)

**Context.** Cindl needs realistic data to develop, test and document its
clients without a Hermes instance, and the desktop app reuses the production
web renderer. A demo must never be mistaken for a connected agent, and no
synthetic record may ship in a build that connects to a real Hermes.

**Decision.**

- `@cindl/fixtures` holds a fictional scenario (an invented ceramics studio)
  implementing `CindlClientApi`. It always reports `link.demo = true`.
- **Flavours.** Synthetic data exists only in demo flavours: the web
  `build:demo` output, a desktop demo package, and an Android demo build. Real
  flavours (web `build`, the desktop real package, the Android release build)
  contain no fixture records and cannot be switched into demo mode at runtime.
- **Fixture records vs labels.** Fixture records are the scenario's names, ids,
  hosts and commands; `SYNTHETIC_FIXTURE_MARKERS` (`@cindl/fixtures/markers`)
  lists strings that only occur there, and a test proves each still does. The
  demo label (`SYNTHETIC_DEMO_LABEL` and `SYNTHETIC_DEMO_NOTICE` in
  `@cindl/contracts`) is required UI copy, present in every renderer build.
- **Labelling.** Whenever a client's link reports `demo: true` it shows the
  persistent notice and a demo document or window title. Packaged demo
  flavours also carry the product name `Cindl Demo`. A demo is therefore
  labelled twice: by the running UI and by the package identity.
- **Gates.** The dist gate fails a real-flavour output that contains any fixture
  marker, and fails a demo-flavour output that lacks the label. Lint forbids
  importing fixtures from production code paths except the explicit,
  build-flag-gated demo switches.
- Integration tests of the real adapter use a fake Hermes server built from
  the vendored upstream contract (in progress), never this scenario.

**Consequences.** Compiling the label out of production renderers is not
allowed; removing fixtures from real flavours is. Screenshots for the handbook
come only from demo flavours and must show the notice.
