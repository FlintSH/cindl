#!/usr/bin/env bash
# Builds, signs and checks Cindl's release APK on a GitHub-hosted runner. For
# the release workflow, on a v* tag push only, never a pull request:
#
#   apps/android/scripts/release-apk.sh <out-dir>
#
# Environment (the secrets only ever through it, never argv, never echoed):
#   CINDL_ANDROID_KEYSTORE_BASE64    base64 of the PKCS12 keystore (secret)
#   CINDL_ANDROID_KEYSTORE_PASSWORD  its store password (secret)
#   CINDL_ANDROID_KEY_ALIAS          its key alias (secret)
#   CINDL_ANDROID_KEY_PASSWORD       its key password (secret)
#   GITHUB_REF_NAME                  the tag, v<version of app.config.ts>
#   RUNNER_TEMP, ANDROID_HOME        as the runner sets them
#
# Writes cindl-<version>-android.apk, its licence notices, apk-report.json and
# SHA256SUMS to <out-dir>. The keystore is $RUNNER_TEMP/cindl-release.p12 while
# the build runs; it is removed when the script ends, and the workflow removes
# it again in an always-run step.
set -euo pipefail
umask 077

out="${1:?usage: release-apk.sh <out-dir>}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
keystore="$RUNNER_TEMP/cindl-release.p12"
trap 'rm -f "$keystore"' EXIT

# 1. The keystore, from its secret (a here-string, so never in argv), owner-only.
base64 -d <<<"$CINDL_ANDROID_KEYSTORE_BASE64" >"$keystore"
unset CINDL_ANDROID_KEYSTORE_BASE64
export CINDL_RELEASE_KEYSTORE="$keystore"
unset CINDL_TEST_KEYSTORE CINDL_TEST_KEYSTORE_PASSWORD
export EXPO_PUBLIC_CINDL_DEMO=''
cd "$root"

# 2. The production native project. The signing plugin refuses an incomplete
#    release environment here, before the build (withTestSigning.ts).
pnpm --filter @cindl/android exec expo prebuild --platform android --no-install --clean
node apps/android/scripts/check-native-project.ts apps/android/android production
node apps/android/scripts/third-party-notices.ts apps/android/android/app/src/main/assets/licenses

# 3. assembleRelease, as the test APK is built: Gradle reads the key from the
#    environment (cindlRelease), and the native notices are collected between
#    the two builds.
abis="$(node apps/android/scripts/android-sdk.ts value abis)"
gradle() {
  (cd apps/android/android && ./gradlew --no-daemon --console=plain --stacktrace \
    --warning-mode=summary -Dorg.gradle.jvmargs="-Xmx6g -XX:MaxMetaspaceSize=1g" \
    -PreactNativeArchitectures="$abis" "$@")
}
gradle :app:assembleRelease
gradle -q :app:dependencies --configuration releaseRuntimeClasspath >"$RUNNER_TEMP/native-dependencies.txt"
node apps/android/scripts/native-notices.ts "$RUNNER_TEMP/native-dependencies.txt" \
  "$HOME/.gradle/caches/modules-2/files-2.1" \
  apps/android/android/app/src/main/assets/licenses/NATIVE-NOTICES.txt
gradle :app:assembleRelease
rm -f "$keystore"

# 4. The release check: the production flavour, signed with the release key
#    (its certificate's SHA-256 is committed in apk-signing.ts).
apk=apps/android/android/app/build/outputs/apk/release/app-release.apk
node apps/android/scripts/check-apk.ts release "$apk" "$RUNNER_TEMP/apk-check"

# 5. The APK with its notices, named by its version, which must be the tag's.
version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).versionName' \
  "$RUNNER_TEMP/apk-check/apk-report.json")"
if [ "${GITHUB_REF_NAME:-}" != "v$version" ]; then
  echo "::error::the tag (${GITHUB_REF_NAME:-none}) is not v$version, the APK's version"
  exit 1
fi
licenses=apps/android/android/app/src/main/assets/licenses
mkdir -p "$out"
cp "$apk" "$out/cindl-$version-android.apk"
cp "$RUNNER_TEMP/apk-check/apk-report.json" "$out/apk-report.json"
cp "$licenses/LICENSE.txt" "$licenses/THIRD-PARTY-NOTICES.txt" "$licenses/NATIVE-NOTICES.txt" "$out/"
(cd "$out" && sha256sum "cindl-$version-android.apk" >SHA256SUMS && cat SHA256SUMS)
