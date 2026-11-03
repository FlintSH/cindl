# 0008 Native Android with Expo / React Native

**Status:** Accepted (SDK licences approved for GitHub-hosted builds and emulator tests; no APK built yet)

**Decision.** The Android app is React Native on Expo SDK 58 (React Native
0.88, React 19.3) using native components, not a WebView. It shares
contracts, client-core, client-react, the adapter and tokens with web. Native
projects are generated (Continuous Native Generation), not committed.

**Toolchain constraint.** The owner approved accepting Google's Android SDK
licence for Cindl APK builds and emulator tests on GitHub-hosted build runners
(2026-11-03). That approval covers only those builds and tests:

- Only the SDK packages the build needs, from a pinned toolchain. Each package
  and the licence it requires is checked before acceptance. Blanket helpers
  that accept every licence (for example piping `yes` into
  `sdkmanager --licenses`) are not used.
- Never on development machines, the Hermes host or anyone's phone; the SDK is
  installed only on GitHub-hosted runners.
- No other terms, no paid services, no Play Store enrollment, and no
  production signing or release. Builds are signed with a debug key only.

Approval is not a build result: no APK has been built yet, and an APK or
emulator run counts only with its CI run and artifact as evidence.
JavaScript bundling and unit tests run anywhere.
