# Android app

Cindl for Android is a native React Native app on Expo SDK 58 (React Native
0.88, React 19.3). It renders native views, not a WebView of the web client,
and has the same four destinations: Talk, Work, Library and Agent. It shares
the client contract, state, React bindings, Hermes adapter helpers and design
tokens with the web client.

## Status

- **Test APKs, built in CI.** Every run of the **Android** workflow builds two
  APKs on GitHub-hosted runners: the synthetic demo and a real build. They are
  test builds, not releases: each run signs them with a new throwaway key (see
  [Test APKs](#test-apks)).
- **Emulator tests in CI.** Each run installs both APKs on an Android 16
  emulator and drives them (see [Emulator tests](#emulator-tests)).
- **Real builds** show **"Cindl is not connected"** and never show demo data.
  The direct Hermes connection (`createDirectClient`, transport stream) is not
  in this version yet. Real builds can already sign in on the device, so the
  tokens are ready when the connection lands.
- **Sign-in** has been exercised on the emulator against a synthetic fake
  Hermes auth server only. It has not been validated against a real Hermes
  server or on a phone.

## Android SDK licence

Building an APK or running an emulator uses Android SDK packages under Google's
Android Software Development Kit License Agreement (sdkmanager id
`android-sdk-license`). On 2026-11-03 the owner approved accepting it **for
Cindl APK builds and emulator tests on GitHub-hosted runners only**. The
approval does not cover development machines, personal devices, paid or store
services, store enrolment or production signing.

The workflow keeps to that scope:

- The SDK jobs refuse to run anywhere but a GitHub-hosted runner, and
  `apps/android/scripts/android-sdk.ts` refuses to download a package anywhere
  else.
- Every package is pinned in `apps/android/sdk/android-sdk.ts`. Before use,
  CI reads Google's repository manifests and checks that each pinned package
  is in the stable channel under `android-sdk-license`, and that the licence
  text is the one approved: the version dated January 16, 2019, identified by
  the SHA-1 of its words (line breaks and other whitespace do not count, every
  word, character and punctuation mark does). Changed wording or another
  licence stops the run for the owner to review.
- Build packages must already be on the runner image; CI never installs them.
  Their `package.xml`, which sdkmanager wrote when GitHub built the image, must
  name `android-sdk-license` with the same words. (sdkmanager stores the text
  with slightly different spacing and line breaks than Google's manifest; the
  check logs the exact difference.)
  The generated project sets `android.builder.sdkDownload=false`, so Gradle
  fails instead of fetching anything.
- Emulator packages are downloaded as the pinned archives and checked against
  their size and SHA-1 from Google's manifest.
- Nothing runs `sdkmanager --licenses`, writes licence files or accepts any
  other terms. A screen that asks to accept terms (for example a browser's
  first run) makes the test report **blocked**; it is never accepted.

| Package                                   | Revision      | Why                                                                      | On the runner      |
| ----------------------------------------- | ------------- | ------------------------------------------------------------------------ | ------------------ |
| `platforms;android-37.0`                  | 2             | compileSdk 37 (React Native, Expo)                                       | preinstalled       |
| `build-tools;37.0.0`                      | 37.0.0        | React Native's build tools; aapt2 and apksigner for APK checks           | preinstalled       |
| `ndk;27.3.13750724`                       | 27.3.13750724 | React Native builds with NDK r27 (it names 27.1.12297006)                | preinstalled       |
| `cmake;3.31.5`                            | 3.31.5        | Native code of React Native and Expo modules                             | preinstalled       |
| `platform-tools`                          | 37.0.1        | adb                                                                      | downloaded archive |
| `emulator`                                | 37.2.13       | Android Emulator, stable channel                                         | downloaded archive |
| `system-images;android-36;default;x86_64` | 2             | Android 16 (API 36, the app's targetSdk), AOSP image without Google apps | downloaded archive |

React Native names NDK 27.1.12297006 and no project names a CMake version, so
`apps/android/plugins/withAndroidToolchain.ts` selects the NDK r27 and CMake that the runner
already has instead of downloading others. To change a pin, read the package's
entry in Google's manifest, confirm its licence is still `android-sdk-license`
with the same text, and update `apps/android/sdk/android-sdk.ts` (revision, archive URL,
size and SHA-1) in a reviewed change.

## Test APKs

Each **Android** workflow run uploads two artifacts, kept for 14 days:
`cindl-android-demo-test-apk` and `cindl-android-production-test-apk`. Each
holds:

- `cindl-<flavour>-test.apk` and `SHA256SUMS`;
- `apk-report.json`: package, label, SDK levels, ABIs, permissions, network
  security config, signer and the bundle gate's result;
- `LICENSE.txt` (Cindl's MIT licence), `THIRD-PARTY-NOTICES.txt` (fonts,
  vendored material and every npm package in the build) and
  `NATIVE-NOTICES.txt` (every library Gradle adds from Maven repositories,
  with the licence its POM declares and the licence and notice files it ships,
  which the Android build would otherwise leave out), all three also inside the
  APK under `assets/licenses/`;
- `native-dependencies.txt`: Gradle's release runtime classpath, the list the
  native notices are made from;
- `android-sdk-packages.json`: the SDK packages the build used, with their
  licence.

The APKs use the release build type (the JavaScript bundle is embedded, so no
Metro server is needed) for arm64-v8a phones and the x86_64 emulator. They are
signed with a key generated for that run and then deleted, never with React
Native's public debug key: anyone can sign with that key, so an "update"
signed with it could take over the app's data. Because every run has a new
key, an APK cannot update one from another run; uninstall first, which deletes
the app's data.

`apps/android/scripts/check-apk.ts` fails the build unless the APK has the right package
and launcher label for its flavour, is not debuggable, asks for `INTERNET`
only, keeps backups off, allows cleartext only to the device itself, carries
the licence notices, is signed with the run's key, and its JavaScript bundle
passes the labelling gate (no fixture records in real builds, the demo notice
in demo builds; ADR 0011).

## Emulator tests

The `emulator` job boots an Android 16 (API 36) emulator from Google's AOSP
system image (no Google apps), 1080 x 2400 at 420 dpi with no hardware
keyboard, and runs `apps/android/e2e/run.ts`. It drives the app through UI
Automator by accessibility labels, so a renamed label fails a test. Data is
synthetic throughout.

The Google APIs image is not used because its only browser is Chrome, and
Chrome's first run asks to accept Google's Terms of Service (and to send usage
data to Google) before it opens any page. Those terms are not part of the
approved SDK licence, so the tests stop there instead of accepting them (they
did on the first run). Signing in through Chrome on an emulator stays untested
until the owner decides about those terms.

- **Demo APK:** the four destinations; system back closing a skill detail, a
  sheet and a side conversation before leaving the app; the approval card
  (Allow once and Deny only) and the question set; sending a message with the
  on-screen keyboard open (composer above the keyboard, navigation hidden);
  every touch target at least 48dp; 200% font size and dark theme; a draft
  surviving background, rotation, activity recreation; a cold start after the
  process is killed.
- **Real APK:** sign-in through a Custom Tab against a fake Hermes auth server
  on the runner (reached through `adb reverse`, so the app sees
  `http://127.0.0.1`), with the authorize request and code exchange checked
  for PKCE S256 and the loopback redirect; sign-in surviving process death;
  sign-out; the app process killed while the browser shows the authorize
  page, which must end in the "interrupted" notice with nothing exchanged;
  and cancelling a sign-in in progress.

System animations are off during the tests so UI dumps are stable (the app then
also reduces its own motion). The `cindl-android-emulator-evidence` artifact
holds screenshots, UI dumps, logcat per step, `report.json` and `summary.md`.
The fake auth server's log records only request shapes, never codes, verifiers
or tokens.

## Demo and real builds

The build decides, never the running app:

- `EXPO_PUBLIC_CINDL_DEMO=1` at build time makes the **synthetic demo**: a
  fictional ceramics studio, no network access to Hermes, a notice on every
  screen ("Synthetic demo. Not connected to Hermes; …") and the launcher name
  **Cindl Demo** (ADR 0011).
- Any other build is a real build, named **Cindl**. Its JavaScript bundle
  cannot contain fixture records: `metro.config.cjs` resolves
  `@cindl/fixtures` to an empty module unless the demo flag is set, and CI
  checks both the exported bundle and the one inside the APK against
  `SYNTHETIC_FIXTURE_MARKERS`. The demo notice itself stays in every build, so
  a demo can never run unlabelled.

## Sign-in

Hermes v0.22.5 must run in login mode (the native PKCE flow). Its redirect
validator accepts only `http://127.0.0.1[:port]/…` or `http://[::1][:port]/…`,
so Cindl does not use custom schemes, App Links or `localhost`. A real build
offers **Sign in on this device** on its "not connected" screen:

1. The owner enters the Hermes address. Only `https://` addresses are accepted,
   or `http://` for `127.0.0.1` and `[::1]` on the device itself; no user name,
   password, path, query or fragment. Only the origin is stored.
2. A small Kotlin listener (`apps/android/modules/cindl-loopback`) binds
   `127.0.0.1` on an ephemeral port. It accepts one `GET /callback` whose
   `state` matches the attempt (compared in constant time) and whose `Host` is
   that listener, records it, answers with a static page (no scripts, no remote
   resources, `Referrer-Policy: no-referrer`) and closes. Any other request gets
   an error page, and a connection that closes, resets or stalls is dropped;
   the listener keeps waiting either way, for at most 5 minutes.
3. The PKCE verifier and state are written to secure storage for the attempt,
   then `/auth/native/authorize` opens in a Custom Tab in Cindl's own task.
4. The owner signs in on Hermes's page (passwords and second factors are never
   typed into Cindl). The page Cindl shows afterwards says to **close the tab**:
   Android 15 and later do not let an app bring itself back over the browser.
   **Cancel sign-in** stops a waiting attempt.
5. Cindl exchanges the one-time code with `POST /auth/native/token` and stores
   the token set encrypted with a key held in the Android Keystore
   (`expo-secure-store`); the signed-in origin, which is not a secret, is kept
   in app storage. The screen then says **"Signed in to … on this device."**

**If Android closes Cindl while the browser is open**, the listener ends with
the app. On the next start Cindl finds the saved attempt, sees that no listener
survived, deletes the verifier and says "Cindl stopped waiting for the browser
(the app was closed during sign-in). Nothing was saved. Start again." If only
the JavaScript runtime restarted, the attempt resumes. **Signing out** deletes
this device's tokens only: Hermes v0.22.5 cannot revoke tokens it already
issued.

Evidence: unit tests run the whole flow against a fake Hermes server
(`apps/android/test/signin.test.ts`), the listener's JUnit tests run on a plain
JVM in CI, and the emulator tests run it through a real Custom Tab against the
fake auth server, including process death. Still missing: a run against a real
Hermes server and on a phone.

## Permissions and network policy

- **Permissions:** `INTERNET` only. Permissions that libraries would add
  (storage, overlay, vibrate, network state) are removed in the generated
  manifest, and CI checks the manifest and the APK. (AndroidX also declares an
  app-private, signature-level permission for its own receivers.)
- **Cleartext:** refused except to `127.0.0.1` and `::1`. Debug builds (never
  distributed) also allow `localhost` and `10.0.2.2` for the Metro dev server.
- **Certificates:** system authorities only. A Hermes server behind a private
  CA or a self-signed certificate is not reachable.
- **Backups:** off. `allowBackup=false`, and data extraction rules exclude
  every storage domain from cloud backups and device-to-device transfers,
  because some Android 12+ devices transfer data despite `allowBackup=false`.
- **Signing:** release builds are signed only with the throwaway CI key; without
  it they stay unsigned (`apps/android/plugins/withTestSigning.ts`).
- **No WebView:** Expo's unused DOM-components WebView module is excluded from
  autolinking.

## How it behaves

- **Agent output** is untrusted: raw HTML is dropped, images are never loaded
  (a placeholder names the host), every link shows its destination host next to
  its text, and opening one asks first, showing the full address. Very deep
  nesting is shown as plain text.
- **Decisions:** approvals offer only Allow once and Deny and lock on the first
  tap; withheld standing grants are explained under "Why only once?". A
  question set is answered (or each question skipped) and sent once; **Skip
  all** skips every open question in one reply. There is no decline: an empty
  reply would reach the agent like an interrupt. Answers another device
  already gave are shown as such and never overridden, and nothing typed is
  lost by picking or skipping.
- **System back** closes an open sheet or dialog first, then steps out of an
  editor review, then a skill detail, then returns to Talk, then from a side
  conversation to the main one, and only then leaves the app.
- **Keyboard:** the composer and sheets stay above the on-screen keyboard; the
  bottom navigation steps aside while it is open. Enter adds a line; the Send
  button sends.
- **Accessibility:** touch targets are at least 48dp (Android's guidance; the
  shared tokens' 44px is the floor for every client), TalkBack labels match the
  web labels, and the system font size, dark theme and "Remove animations"
  setting are followed. A destination keeps its scroll position when you come
  back to it.

## Build and check locally

No Android SDK or JDK is needed for these, and none may be installed on shared
development machines (see [Android SDK licence](#android-sdk-licence)):

```sh
# From the repository root:
pnpm --filter @cindl/android typecheck
pnpm exec vitest run --project android
EXPO_PUBLIC_CINDL_DEMO=1 pnpm --filter @cindl/android exec expo export --platform android --output-dir dist-demo
node apps/android/scripts/check-bundle.ts demo apps/android/dist-demo/_expo/static/js/android/*.hbc
EXPO_PUBLIC_CINDL_DEMO=1 pnpm --filter @cindl/android exec expo prebuild --platform android --no-install
node apps/android/scripts/check-native-project.ts apps/android/android demo
node apps/android/scripts/android-sdk.ts verify-repositories build   # reads Google's manifests only
```

`pnpm lint` applies the root rules to the whole app. The code that ships
(`src`, `index.ts`, `modules`) also gets the root's rules for browser-facing
code (no browser storage, no aliases of global objects) and the Android rules
in `apps/android/lint/rules.mjs`: colours come from the theme, there is no
`document` or `window`, and device storage (AsyncStorage, `expo-secure-store`)
is opened only in `src/platform` (`storage.ts` and `secretStore.ts`).

APKs and emulator runs happen only in CI. `android/` is generated by prebuild
and git-ignored. Metro needs no monorepo settings: Expo's config already
resolves pnpm's isolated `node_modules` and the TypeScript sources of
`@cindl/*`. Launcher and splash images are generated from the tokens by
`node apps/android/scripts/render-icons.ts`.

## Troubleshooting

- **"Cindl stopped waiting for the browser":** Android closed Cindl during
  sign-in. Start again; nothing was saved.
- **An `http://` address is refused:** use `https://`; plain HTTP works only
  for `127.0.0.1` or `[::1]` on the device itself.
- **An APK from another run will not install over the current one:** each run
  signs with its own key. Uninstall first (this deletes the app's data).
- **CI says a pinned SDK package is missing or not approved:** the runner image
  or Google's manifest changed. The message names the package, revision and
  licence. Review the change and update `apps/android/sdk/android-sdk.ts`; never add
  `sdkmanager --licenses` or a licence file.

## Known limits

- Not connected to a real Hermes yet (transport pending); sign-in not
  validated against a real Hermes server or on a phone.
- Test APKs only: no store distribution, no production signing.
- Native libraries are listed with the licence their POM declares. A library
  whose POM declares no licence and that ships no licence file stops the APK
  build until someone reviews it; no licence is filled in by hand.
- No hardware-keyboard shortcuts or command palette; Enter does not send.
- No notifications or background sync.
- Artifacts, attachments and memory entries are shown as unsupported, as in
  the other clients.
- Licence texts are shipped in the APK but not yet shown in the app.
