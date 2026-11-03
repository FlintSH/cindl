# Android app

Cindl for Android is a native React Native app on Expo SDK 58 (React Native
0.88, React 19.3). It renders native views, not a WebView of the web client,
and has the same four destinations: Talk, Work, Library and Agent. It shares
the client contract, state, React bindings, Hermes adapter helpers and design
tokens with the web client.

## Status

- **No APK yet.** Building an APK (Gradle and the Android Gradle plugin) or
  running an emulator uses Android SDK packages under Google's licence terms.
  Accepting those terms is the owner's decision and has not been made, so no
  build machine, CI included, builds or installs anything from the Android SDK
  for Cindl. The generated project also sets `android.builder.sdkDownload=false`
  so that a build can never download SDK packages on its own.
- **CI runs SDK-free checks** (workflow **Android**): typecheck, lint and unit
  tests, production and demo JavaScript bundles with their labelling gates, the
  generated native projects, and the Kotlin sign-in listener's tests on a plain
  JVM.
- **Real builds** show **"Cindl is not connected"** and never show demo data.
  The direct Hermes connection (`createDirectClient`, transport stream) is not
  in this version yet; when it lands, real builds use the Android platform
  pieces described below.
- **Sign-in** is implemented and unit-tested, but it has **not** been validated
  on a device or emulator against a Hermes server. Do not rely on it until that
  validation is recorded in the acceptance matrix.

## Demo and real builds

The build decides, never the running app:

- `EXPO_PUBLIC_CINDL_DEMO=1` at build time makes the **synthetic demo**: a
  fictional ceramics studio, no network access to Hermes, a notice on every
  screen ("Synthetic demo. Not connected to Hermes; …") and the launcher name
  **Cindl Demo** (ADR 0011).
- Any other build is a real build, named **Cindl**. Its JavaScript bundle
  cannot contain fixture records: `metro.config.cjs` resolves
  `@cindl/fixtures` to an empty module unless the demo flag is set, and CI
  checks a production bundle against `SYNTHETIC_FIXTURE_MARKERS`
  (`apps/android/scripts/check-bundle.ts`). The demo notice itself stays in
  every build, so a demo can never run unlabelled.

## Sign-in

Hermes v0.22.5 must run in login mode (the native PKCE flow). Its redirect
validator accepts only `http://127.0.0.1[:port]/…` or `http://[::1][:port]/…`,
so Cindl does not use custom schemes, App Links or `localhost`:

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
5. Cindl exchanges the one-time code with `POST /auth/native/token`, stores the
   token set encrypted with a key held in the Android Keystore
   (`expo-secure-store`), and refreshes it with `POST /auth/native/refresh`.

**If Android closes Cindl while the browser is open**, the listener ends with
the app. On the next start Cindl finds the saved attempt, sees that no listener
survived, deletes the verifier and reports the sign-in as interrupted; the
owner starts again. If only the JavaScript runtime restarted, the attempt
resumes. **Signing out** deletes this device's tokens only: Hermes v0.22.5
cannot revoke tokens it already issued.

Evidence today: unit tests run the whole flow against a fake Hermes server
(`apps/android/test/signin.test.ts`), and the listener's JUnit tests run on a
plain JVM in CI. Still missing: a run on a device or emulator against a Hermes
test server, including the process-death case.

## Permissions and network policy

- **Permissions:** `INTERNET` only. Permissions that libraries would add
  (storage, overlay, vibrate, network state) are removed in the generated
  manifest, and CI checks it. (AndroidX also declares an app-private,
  signature-level permission for its own receivers when an APK is built.)
- **Cleartext:** refused except to `127.0.0.1` and `::1`. Debug builds (never
  distributed) also allow `localhost` and `10.0.2.2` for the Metro dev server.
- **Certificates:** system authorities only. A Hermes server behind a private
  CA or a self-signed certificate is not reachable.
- **Backups:** off. `allowBackup=false`, and data extraction rules exclude
  every storage domain from cloud backups and device-to-device transfers,
  because some Android 12+ devices transfer data despite `allowBackup=false`.
- **No WebView:** Expo's unused DOM-components WebView module is excluded from
  autolinking.

## How it behaves

- **Agent output** is untrusted: raw HTML is dropped, images are never loaded
  (a placeholder names the host), every link shows its destination host next to
  its text, and opening one asks first, showing the full address. Very deep
  nesting is shown as plain text.
- **Decisions:** approvals offer only Allow once and Deny and lock on the first
  tap; withheld standing grants are explained under "Why only once?". A
  question set is answered (or each question skipped) and sent once; answers
  another device already gave are shown as such and never overridden, and
  nothing typed is lost by picking or skipping.
- **System back** closes an open sheet or dialog first, then steps out of an
  editor review, then a skill detail, then returns to Talk, then from a side
  conversation to the main one, and only then leaves the app.
- **Keyboard:** the composer and sheets stay above the on-screen keyboard; the
  bottom navigation steps aside while it is open. Enter adds a line; the Send
  button sends.
- **Accessibility:** 44dp touch targets, TalkBack labels that match the web
  labels, the system font size, dark theme and "Remove animations" setting are
  followed. A destination keeps its scroll position when you come back to it.

## Build and check locally

No Android SDK or JDK is needed for these:

```sh
pnpm --filter @cindl/android typecheck
pnpm exec vitest run --project android
cd apps/android
EXPO_PUBLIC_CINDL_DEMO=1 pnpm exec expo export --platform android --output-dir dist-demo
node scripts/check-bundle.ts demo dist-demo/_expo/static/js/android/*.hbc
EXPO_PUBLIC_CINDL_DEMO=1 pnpm exec expo prebuild --platform android --no-install
node scripts/check-native-project.ts android demo
```

`android/` is generated by prebuild and git-ignored. Metro needs no monorepo
settings: Expo's config already resolves pnpm's isolated `node_modules` and the
TypeScript sources of `@cindl/*`. Launcher and splash images are generated from
the tokens by `node apps/android/scripts/render-icons.ts`.

## Troubleshooting

- **"Cindl stopped waiting for the browser":** Android closed Cindl during
  sign-in. Start again; nothing was saved.
- **An `http://` address is refused:** use `https://`; plain HTTP works only
  for `127.0.0.1` or `[::1]` on the device itself.

## Known limits

- No APK until the owner approves the Android SDK terms for a build machine.
- Not connected to a real Hermes yet (transport pending); sign-in not
  validated on a device.
- No hardware-keyboard shortcuts or command palette; Enter does not send.
- No notifications or background sync.
- Artifacts, attachments and memory entries are shown as unsupported, as in
  the other clients.
- Licence texts of bundled fonts and libraries are not yet shown in the app.
