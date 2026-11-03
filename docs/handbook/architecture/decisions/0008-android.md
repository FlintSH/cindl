# 0008 Native Android with Expo / React Native

**Status:** Accepted (build pipeline pending)

**Decision.** The Android app is React Native on Expo SDK 58 (React Native
0.88, React 19.3) using native components, not a WebView. It shares
contracts, client-core, client-react, the adapter and tokens with web. Native
projects are generated (Continuous Native Generation), not committed.

**Toolchain constraint.** No Android SDK licence is accepted on the owner's
behalf on shared development machines. APKs are built in CI on runners that ship a licensed
SDK. Release builds are signed with a debug key only; store distribution and
production signing are out of scope until the owner decides otherwise.
