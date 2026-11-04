# 0008 Native Android with Expo / React Native

**Status:** Accepted (Google's Android SDK licence approved for Cindl APK builds and emulator tests on existing GitHub build runners only; `main` builds both test APKs, checks them and runs the emulator steps whenever Android or shared code changes, for example run 41791125629). Real builds run the direct client with one PKCE implementation, the adapter's `NativeAuth`, and keep tokens in the Keystore; the agent's screen paints through a local Expo module (`apps/android/modules/cindl-screen`). The SDK package list is unchanged. Tested in Node against the fake Hermes, and on the GitHub runners, where all three Kotlin modules are compiled into each test APK (`apps/android/scripts/check-apk.ts` checks the list in `apps/android/scripts/kotlin-modules.ts`) and the emulator runs the demo and the sign-in flows against the fake Hermes. No physical device run has happened.

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
- No other terms, no paid services and no Play Store enrollment. The one
  production signing is the release the owner approved for v1.0.0: a
  production APK signed with a stable key, kept in GitHub Actions secrets and
  used only by the release workflow on a `v*` tag, published on GitHub
  Releases. Test builds are signed with a throwaway key made for each CI run,
  never the public debug key or a store or production key.

Approval is not a build result: an APK or emulator run counts only with its CI
run and artifact as evidence. Both test APKs are built on `main` whenever
Android or shared code changes (run 41791125629 is one), as run artifacts.
JavaScript bundling and unit tests run anywhere.
