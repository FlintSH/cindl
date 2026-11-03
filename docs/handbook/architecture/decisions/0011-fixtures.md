# 0011 Synthetic fixtures for tests and a labelled demo only

**Status:** Accepted

**Decision.** `@cindl/fixtures` holds a fictional scenario (an invented
ceramics studio) implementing `CindlClientApi`. It is used by tests, by the
web build only when `VITE_CINDL_DEMO=1`, and for documentation screenshots, and
it always reports `link.demo = true` so clients show a banner. Lint forbids
importing it from production code paths. Integration tests of the real adapter
will use a fake Hermes server built from the vendored upstream contract (in
progress), never this
scenario.
