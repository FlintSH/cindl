# Android app

Cindl for Android is a native React Native app on Expo SDK 58 (React Native
0.88, React 19.3). It renders native views, not a WebView of the web client,
and has the same four destinations: Talk, Work, Library and Agent. It shares
the client contract, the direct Hermes client, state, React bindings and
design tokens with the other clients.

## Status

- **Test APKs, built in CI.** Every run of the **Android** workflow builds two
  APKs on GitHub-hosted runners: the synthetic demo and a real build. They are
  test builds, not releases: each run signs them with a new throwaway key (see
  [Test APKs](#test-apks)).
- **Emulator tests in CI.** Each run installs both APKs on an Android 16
  emulator and drives them (see [Emulator tests](#emulator-tests)).
- **Real builds** connect to your Hermes server through the direct client
  (client-core `createDirectClient`), signed in on the device with native PKCE
  (see [Sign-in](#sign-in)). They never show demo data.
- **Tested against synthetic servers only.** The real build's client runs
  against the fixtures' fake `hermes serve` in unit tests and, in CI, on the
  emulator. It has not been validated against a real Hermes server or on a
  phone.

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
  first run) makes the test report **blocked**; it is never accepted, and a
  blocked step fails the job like a failed one (`apps/android/e2e/outcome.ts`),
  so a job never goes green without doing what it tests.

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
  security config, signer, the bundle gate's result, the local Kotlin modules
  found compiled into the dex (`kotlinModules`; the check fails without both)
  and whether any dex refers to WebView (`refersToWebView`, reported only);
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

`check-apk.ts` checks that the notice files are in the APK, not that they are
complete. Code compiled into React Native's and Hermes's prebuilt native
libraries (`.so` files) reaches `NATIVE-NOTICES.txt` only if those libraries'
AARs ship its notice. Before calling an APK's notices complete, read its
`NATIVE-NOTICES.txt` for the native code React Native 0.88 pins
(`react-native/gradle/libs.versions.toml`): folly 2024.11.18.00 (Apache-2.0),
glog 0.3.5, gflags 2.2.0 and double-conversion 1.1.6 (BSD-3-Clause, whose
notice binary distributions must carry), boost 1.83.0 (BSL-1.0), fmt 12.1.0
and nlohmann json 3.11.2 (MIT), fast_float 8.0.0 (MIT, Apache-2.0 or BSL-1.0),
and Hermes's own bundled third-party code. Any that is missing has to be added
to the notices before an APK is distributed.

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
  (Allow once and Deny only) and the question set; the sudo prompt's card
  offering nothing to send; agent output with a link (its host shown, a
  confirmation with the full address before anything opens, from a tap on the
  link's text on either of its two lines) and a withheld remote image; a memory entry's delete warning and a reviewed
  edit; the demo's synthetic screen drawn live in Work, Computer (a pixel
  of its desktop read back from the screen) and, after taking control, a tap
  drawing its orange pointer marker where it landed; sending a message with the
  on-screen keyboard open (composer above the keyboard, navigation hidden);
  every touch target at least 48dp; 200% font size and dark theme; a draft
  surviving background, rotation, activity recreation; a cold start after the
  process is killed.
- **Production APK:** the sign-in screen (no demo data); sign-in through the
  emulator's browser (the AOSP image has no Chrome: run 41593367518 logged
  `org.chromium.webview_shell/.WebViewBrowserActivity`, which opens the page as
  a plain browser, not a Custom Tab) against the fixtures' fake `hermes serve`
  on the runner (reached through `adb reverse`, so the app sees
  `http://127.0.0.1`), which refuses an authorize request without S256 PKCE or
  a loopback redirect and a code exchange whose verifier does not match; the
  direct client connecting (`/api/ws`). Then, against that fake:
  - **Tokens:** the token set kept in expo-secure-store's
    `shared_prefs/SecureStore.xml` as AES ciphertext from an Android Keystore
    key alias, and neither a token value the fake issued nor a token field name
    in plain text in any file of the app's storage. Every file in its
    credential- and device-encrypted data directories is read with adbd as
    root, which the AOSP image allows, and searched for each token the fake
    issued. Only facts are kept, in `keystore-evidence.json`: the files
    searched and any that held a token, never a value or the ciphertext.
  - **Refresh:** the fake issues 90-second access tokens, so the app refreshes
    one before it expires (`POST /auth/native/refresh`), reads Memory with it,
    and stores the new set, encrypted again, with no token in plain text. A
    cold start after process death then connects without the browser: the fake
    stopped accepting the first token set when it rotated it, so the app read
    the refreshed set back from its storage.
  - **Sign-out:** the sign-in screen comes back, the token set is deleted from
    the device, and no token issued during the run is in plain text in the
    app's files.
  - **Logs:** no token, ticket, code, state or PKCE verifier the run issued
    or received is in the device log (logcat, read after every step and kept
    raw in memory only).
  - **The agent's screen:** the fake's synthetic screen, served over
    `/api/display/ws`, drawn by the Kotlin painter (a pixel of its desktop
    read back), and in control, a tap that reaches the fake through its lease
    gate and draws the orange pointer marker where it landed. The fake is
    asked which view held control before the app gives control back: once the
    lease returns to the agent, it no longer says
    (`apps/android/test/e2e-screen.test.ts` runs that order on loopback).
  - **Chat:** a message answered by the fake.

  Against a second stand-in whose authorize page can be held open: the app
  process killed while the browser shows that page, which must end in the
  "interrupted" notice with nothing exchanged, and cancelling a sign-in in
  progress.

  What this does not prove: sign-in through Chrome or a Custom Tab (the
  owner's decision 7), a real Hermes, a Keystore backed by phone hardware (the
  emulator's is software), or Hermes's own token lifetimes.

The memory editor's lock, adoption and kept-draft flows need memory changed
elsewhere while an entry is open, which the demo cannot do. Node tests run
them instead (`apps/android/test/memory-identity.test.ts`,
`memory-adoption.test.ts` and `memory-drafts.test.ts`, the web client's
probes with their assertions) on `apps/android/test/memoryScreen.ts`, which
keeps the editor's state and wiring and calls the same functions the
components call. How those states render in React Native, where TalkBack
focus lands and what TalkBack reads are not covered by an emulator test yet.

Each step starts from a known screen, so one failure does not fail the steps
after it: Cindl in front, nothing left open over it (system back closes a
dialog or sheet a step left), and Talk selected, with or without a
conversation. System animations are off during the tests so UI dumps are stable
(the app then also reduces its own motion). The `cindl-android-emulator-evidence` artifact
holds, per suite (`demo/`, `signin/`), screenshots, UI dumps, logcat per step,
`report.json` (steps, device, the fake's request shapes) and `summary.md`, and
for the production APK `keystore-evidence.json`. Nothing in it holds a
sign-in value: every token, ticket, code, state and verifier the fake Hermes
and the auth stand-in issue or receive is replaced in device logs, UI dumps and
report lines by a placeholder naming its kind (`[issued-code]`), and the
adapter's redaction runs over the rest (`apps/android/e2e/secrets.ts`). The
browser is never captured, because its address bar and pages show the code
and state; the steps note what it showed instead. The fake auth server's log
records only request shapes, never codes, verifiers or tokens.

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
with no Hermes session shows **Sign in to Hermes** (or **Signed out**):

1. The owner enters the Hermes address. Only `https://` addresses are accepted,
   or `http://` for `127.0.0.1` and `[::1]` on the device itself; no user name,
   password, path, query or fragment.
2. The direct client checks that Hermes offers native sign-in, then the
   adapter's `NativeAuth` (the same PKCE code the desktop app runs) creates the
   PKCE verifier and state in memory.
3. A small Kotlin listener (`apps/android/modules/cindl-loopback`) binds
   `127.0.0.1` on an ephemeral port. It accepts one `GET /callback` whose
   `state` matches the attempt (compared in constant time) and whose `Host` is
   that listener, records it, answers with a static page (no scripts, no remote
   resources, `Referrer-Policy: no-referrer`) and closes. Any other request gets
   an error page, and a connection that closes, resets or stalls is dropped.
   Connections are served one at a time, each read waits at most 2 seconds and
   a request head may be 8 KiB; the attempt's 5-minute limit is checked between
   connections. So a local app that sends a byte every couple of seconds can
   keep the listener busy, and the sign-in waiting, past 5 minutes until the
   owner presses **Cancel sign-in**. It cannot finish the sign-in: the callback
   must carry the attempt's state, and only Cindl holds the PKCE verifier.
4. `/auth/native/authorize` opens in a Custom Tab in Cindl's own task (on a
   device whose browser offers no Custom Tabs, in that browser). The
   owner signs in on Hermes's page (passwords and second factors are never
   typed into Cindl). The page Cindl shows afterwards says to **close the tab**:
   Android 15 and later do not let an app bring itself back over the browser.
   **Cancel sign-in** stops a waiting attempt; nothing is saved.
5. `NativeAuth` exchanges the one-time code with `POST /auth/native/token` and
   keeps the token set encrypted with a key held in the Android Keystore
   (`expo-secure-store`); it refreshes the tokens before they expire. Only then
   is the address stored (in app storage; it is not a secret), and the client
   connects. Signing in to another Hermes forgets the previous one's tokens,
   once that sign-in succeeded. A sign-in that fails or is cancelled changes
   nothing: a working session stays connected as it was, and without one the
   screen shows the reason and stays signed out. If the connection does not
   come up (for example `/api/ws` fails), the
   sign-in screen says so, with the reason, and offers **Continue to Cindl**:
   the app then shows the connection's state and keeps trying, and Agent can
   sign out.

While the browser is open, the app keeps a marker of the attempt (an id and a
time, no verifier, state or code). **If Android closes Cindl meanwhile**, the
listener and the verifier end with the app. On the next start Cindl finds the
marker and says "Cindl stopped waiting for the browser (the app was closed
during sign-in). Nothing was saved. Start again." The same happens if only the
JavaScript runtime restarted: the verifier was in its memory. **Signing out**
deletes this device's tokens only: Hermes v0.22.5 cannot revoke tokens it
already issued. Whenever the session ends, by signing out or because Hermes
refused the session, Cindl forgets drafts the app kept in memory (an edit kept
after a conflict, a lock or while used for another memory entry, and unsent
answers to questions), so none comes back after another sign-in, to the same
Hermes or another. The address stays, ready to sign in again.

A device that signed in with an earlier build (which ran its own PKCE before
the direct client existed) keeps its sign-in: on the first start, its tokens
move to where `NativeAuth` reads them (the adapter's `nativeTokensKey`) and the
old record is deleted; an
unfinished earlier attempt, whose PKCE verifier is deleted with it, is
reported as interrupted. This only applies to an update signed with the same
key as the earlier build. Every CI test APK is signed with its own throwaway
key, so no CI APK installs over another, and no build distributed so far can
carry a sign-in over.

Cindl checks at start whether the Keystore can encrypt, by writing, reading
back and deleting a canary value (expo-secure-store's own check only says its
module is there). If it cannot, Cindl says so: after a sign-in it keeps the
tokens in memory only and forgets them when the app closes. If the Keystore
refuses a write later, the sign-in still finishes, the tokens stay in memory
only (never in plaintext on disk), and Cindl says so then.

Evidence: unit tests run the real client, with the app's own storage, socket,
crypto and loopback pieces, against the fixtures' fake Hermes
(`apps/android/test/direct.test.ts`), including a Keystore that cannot encrypt;
the listener's JUnit tests run on a plain JVM in CI; and the emulator tests
run it through the emulator's browser, including process death (see
[Emulator tests](#emulator-tests): WebView Shell, not a Custom Tab, and a
step stopped by terms fails the job). Still missing: a run against a real
Hermes server, Chrome's Custom Tab, and a phone.

## Permissions and network policy

- **Permissions:** `INTERNET` only. Permissions that libraries would add
  (storage, overlay, vibrate, network state) are removed in the generated
  manifest, and CI checks the manifest and the APK. (AndroidX also declares an
  app-private, signature-level permission for its own receivers.)
- **Cleartext:** refused except to `127.0.0.1` and `::1`. Debug builds (never
  distributed) also allow `localhost` and `10.0.2.2` for the Metro dev server.
- **Screen socket:** the agent screen's picture uses Hermes's
  `/api/display/ws`, whose single-use ticket travels in the URL (ADR 0012), so
  that URL is a secret: Cindl opens it only to the signed-in origin (`wss`, or
  `ws` only for `127.0.0.1` and `[::1]`), only on that path and with the ticket
  as its only query, and never logs it or puts it in an error. React Native
  carries its binary frames between Kotlin and JavaScript as base64.
- **Certificates:** system authorities only. A Hermes server behind a private
  CA or a self-signed certificate is not reachable.
- **Backups:** off. `allowBackup=false`, and data extraction rules exclude
  every storage domain from cloud backups and device-to-device transfers,
  because some Android 12+ devices transfer data despite `allowBackup=false`.
- **Signing:** release builds are signed only with the throwaway CI key; without
  it they stay unsigned (`apps/android/plugins/withTestSigning.ts`).
- **No WebView:** Expo's unused DOM-components WebView module is excluded from
  autolinking. `@expo/log-box` is still autolinked and compiles an
  `android.webkit.WebView` wrapper, which only debug builds use, with
  `EXPO_UNSTABLE_LOG_BOX` set. The test APKs are release builds minified with
  R8, which should remove it; `check-apk.ts` reports whether an APK's dex
  refers to WebView (`refersToWebView` in `apk-report.json`) but does not fail
  on it.

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
  lost by picking or skipping. An answer shows as sending until Hermes
  acknowledges it; if it fails, the card can be answered again. A message
  that starts with "Not sent:" is shown as it is: nothing reached Hermes.
- **Prompts Cindl does not answer** (a sudo password, a secret, a vault code,
  or a kind Cindl does not know) show as read-only **Answer outside Cindl**
  cards: what Hermes is waiting for, and nothing to send, not even a decline,
  because any reply could become the password Hermes uses. Answer them in
  another Hermes surface, such as the Hermes terminal; the card stays until
  Hermes closes the prompt. Prompts that belong to no conversation are listed
  under Work, Needs you.
- **Memory** (Library, Memory) lists Hermes's memory entries: agent notes
  and notes about you, each named by its place in its list. Editing one goes
  through a review of the exact changes and a confirmation, and the save names
  the entry Hermes listed (its id includes a fingerprint of its text), so
  Hermes refuses it if the entry changed after it was read. Deleting asks
  first, names the entry and cannot be undone: Hermes keeps no backup.
- **An open memory entry stays bound to the entry you opened**, by its text,
  from the moment you open it; only a save there (to the saved text) or
  **Use this draft for the entry now here** changes which entry it is. It
  follows the entry when only its number changes (an entry in the other store
  was removed) and reads it again under its new id. Any other text at its
  place, even before the first read arrives, may be the same entry changed
  elsewhere, or another entry removed, merged or added there, and Hermes's
  list cannot tell which. So the editor locks, keeps your text read-only,
  names the entry now at its place, and saves or deletes nothing; it never
  reads that other entry on its own. When an entry before it in the same
  store was removed, the entry moved up a place: the locked editor says where
  the same text is now (its row reads "No longer at this place" when nothing
  took its place), and your draft comes back when you open it there. A
  locked editor with a draft can reload the list.
  - **Use this draft for the entry now here** reads that entry first, saying
    so while it does; TalkBack describes the button by the entry now at the
    place. Nothing changes unless the read succeeds and the entry is still at
    that place; a failed or refused read is shown, your draft is kept, and you
    can try again. If the entry changed again, Cindl fetches the list, so the
    next try uses the entry now there. Then you review the draft against that
    entry's text before saving. Discarding the draft while the read is out
    cancels the adoption.
  - A draft stays kept for the entry it was written for until you save or
    discard that draft, including while you edit it for another entry. So
    closing the editor loses nothing: the draft goes back to that entry while
    Hermes lists it, and otherwise waits under **Unsaved drafts**. It never
    follows the entry you used it for. A save that finishes after the editor
    locked forgets the draft's kept copy wherever the lock filed it, so saved
    text is never listed as unsaved, and a refused save keeps the draft once.
  - An entry's own kept draft is never replaced or forgotten by other text,
    and it is the one that returns when you open the entry. When the editor
    shows the entry without it, the draft is offered (**Continue the draft**,
    **Discard the draft**). Editing afresh, saving or discarding that fresh
    text leaves it; if the fresh text must be kept too, it is kept beside it
    and waits under **Unsaved drafts**. Drafts for entries Hermes no longer
    lists stay there too, to copy or discard; TalkBack names each discard
    button by its draft.
  - When a locked editor's entry has moved, the lock says where the text you
    were editing goes when you close it: back with the entry, back to the
    entry it was written for, or under **Unsaved drafts**.
  - A delete names the text it removes: the first line with words in it, of
    the text Cindl read under the id the delete sends ("this entry" if there
    is none). The confirmation closes if the entry read there changes.
    Deleting warns first, because Hermes keeps no backup.
  - TalkBack focus moves into your draft when an adoption completes, and onto
    the lock notice whenever the editor locks: Android cannot tell whether the
    control TalkBack was on is the one the lock removed.
  - After a save, the text it replaced stays on screen: restorable only onto
    the version that save produced, otherwise shown to copy.
  - Known limit: entries with identical text in one store look the same to
    Cindl, so they share one kept draft, and an editor may follow either.
- **The agent's screen** (Work, Computer) shows the agent-owned screen live
  when Hermes's screen is running and the client has negotiated the picture
  (the labelled demo streams a synthetic screen), with its state, who
  controls it, and Take control and Give control back. Watching sends no
  input. In control, a tap is a left click, a drag moves with the button
  held, a long press is a right click and two fingers moving up or down turn
  the wheel (up scrolls down, as on a phone); **Keyboard** opens the
  on-screen keyboard, whose keys (Enter and Backspace included) go to the
  screen, with arrow buttons beside it. The picture's label says whether you
  are watching or in control, and TalkBack moves past it like any other
  element. Cindl never starts, stops or installs the screen. See
  [Live screen](#live-screen).
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

## Live screen

The picture comes from Hermes's `/api/display/ws` (ADR 0012). The direct
client opens it through the app's screen socket (see
[Permissions and network policy](#permissions-and-network-policy)), speaks
RFB and hands back only the regions that changed since the last frame, as
RGBA bytes. Work, Computer asks for the next frame only after the last one
was painted, so frames never queue up, and it ends the view when it closes,
also when a watch answers after that. A view that ends on its own (a screen
too large to show, a failed frame) is ended too, so its socket and any control
this device held do not outlive it. **Try again** paints a new surface for the
new view, which the picture then draws.

The picture is drawn by a local Expo module (`apps/android/modules/cindl-screen`):
one Android bitmap of the screen's size, painted region by region and drawn
centred with its aspect kept. Each region reaches Kotlin as a typed array read
in place through JSI, so the pixels are not copied or base64-encoded across
the bridge. In Kotlin each region is converted once into a scratch array of
ARGB ints and copied from there into the bitmap (`Bitmap.setPixels`). Only the
newest pixels are kept: the client's framebuffer and the bitmap, each width x
height x 4 bytes (4.1 MB at 1280x800), and that scratch array on the Java heap,
which grows to the largest region painted so far and is kept for the
surface's life (up to the bitmap's size). All are capped like the client at
4096x4096 in area, where each takes 64 MiB, which a phone with a small heap may
not have.

Painting and drawing share one lock, but Android's renderer uploads the bitmap
later, on its own thread, possibly while the next region is being painted. A
frame can then show part old and part new pixels (tearing) until the next
paint; only a phone can show how often.

What it costs is the way in: React Native's WebSocket carries binary frames
between Kotlin and JavaScript as base64. A full 1280x800 Raw repaint is
4,096,016 bytes on the socket and 5,461,356 base64 characters across the
bridge. On this repository's build machine (`apps/android/scripts/measure-screen.ts`,
median of 5), decoding that in JavaScript took 16 ms with V8's JIT and 247 ms
with V8's interpreter only (closer to Hermes, which has no JIT); the RFB
client then took 8 and 65 ms to read it and copy the region out. Most frames
are far smaller, because only changed regions are sent. The pure-JavaScript
alternative, a BMP data URI for `<Image>` per frame, took 57 and 233 ms and
4,096,094 characters before the image is even decoded, so it is not used.

Input goes only while this device holds control, and it is never logged.
A touch is mapped through the picture's displayed scale to a screen pixel (a
gesture that starts off the picture sends nothing). Between paints only the
newest position of a drag is kept, never at the cost of a press or release,
and each `display.input` call carries at most 64 events. Giving control back
drops whatever was still waiting. Keys come from a hidden text field that
never keeps the text; Tab and other control characters are not sent.

Only an emulator or a phone can show: the frame rate and the Kotlin side's
cost (OkHttp's base64 encode, the ARGB conversion, `Bitmap.setPixels`, drawing),
memory use on a device (the scratch array included), tearing, that **Try
again** brings the picture back (Node tests model the Kotlin surfaces), that
the picture is drawn where the tests expect it,
how gestures feel and whether a scroll view or the system takes them first,
how real keyboards (Gboard, Samsung, hardware) deliver keys to the hidden
field, TalkBack in control, and how it behaves on a slow network or after the
app goes to the background. The emulator suite covers the drawn picture and a
tap in control on the synthetic screen; the rest needs a phone.

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
is opened only in `src/platform`: AsyncStorage in `storage.ts`, and
`expo-secure-store` in `android.ts`, which hands it to `secretStore.ts`.

APKs and emulator runs happen only in CI. `android/` is generated by prebuild
and git-ignored. Metro needs no monorepo settings: Expo's config already
resolves pnpm's isolated `node_modules` and the TypeScript sources of
`@cindl/*`. Launcher and splash images are generated from the tokens by
`node apps/android/scripts/render-icons.ts`.

## Troubleshooting

- **"Cindl stopped waiting for the browser":** Android closed Cindl during
  sign-in. Start again; nothing was saved.
- **"This Hermes server does not offer native sign-in":** Hermes is not in
  login mode (no `native_pkce` in its status). Cindl does not read the
  loopback-token mode's per-process token.
- **An `http://` address is refused:** use `https://`; plain HTTP works only
  for `127.0.0.1` or `[::1]` on the device itself.
- **An APK from another run will not install over the current one:** each run
  signs with its own key. Uninstall first (this deletes the app's data).
- **CI says a pinned SDK package is missing or not approved:** the runner image
  or Google's manifest changed. The message names the package, revision and
  licence. Review the change and update `apps/android/sdk/android-sdk.ts`; never add
  `sdkmanager --licenses` or a licence file.

## Known limits

- Not validated against a real Hermes server or on a phone: the client has
  run against synthetic servers only.
- The agent's screen takes no middle click, clipboard or key combinations
  (Ctrl or Alt with a key), and text arrives one character at a time
  (keyboard suggestions are off in that field).
- Test APKs only: no store distribution, no production signing.
- Native libraries are listed with the licence their POM declares. A library
  whose POM declares no licence and that ships no licence file stops the APK
  build until someone reviews it; no licence is filled in by hand.
- No hardware-keyboard shortcuts or command palette; Enter does not send.
- No notifications or background sync.
- Artifacts and attachments are shown as unsupported, as in the other
  clients.
- Licence texts are shipped in the APK but not yet shown in the app.
