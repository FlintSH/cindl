# 0008 Native Android with Expo / React Native

**Status:** Accepted (APK build blocked on owner approval of SDK licence terms)

**Decision.** The Android app is React Native on Expo SDK 58 (React Native
0.88, React 19.3) using native components, not a WebView. It shares
contracts, client-core, client-react, the adapter and tokens with web. Native
projects are generated (Continuous Native Generation), not committed.

**Toolchain constraint.** No Android SDK, Google or emulator licence is
accepted on the owner's behalf, on development machines or in CI. A runner's
preinstalled SDK may be used only where the build needs no new licence
acceptance and no download, and that has been verified; Gradle runs with
`android.builder.sdkDownload=false` so a missing component fails the build
instead of being fetched. Anything that would accept terms (for example an
emulator action that pipes `yes` into `sdkmanager --licenses`) is not used.
Until the owner approves specific terms, APK builds and emulator runs are
blocked; JavaScript bundling and unit tests continue. Release builds would be
signed with a debug key only; store distribution and production signing are
out of scope until the owner decides otherwise.
