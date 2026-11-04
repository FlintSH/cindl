/**
 * The local Kotlin modules (`apps/android/modules`), by the name each one's
 * Module class declares (`Name(...)`). check-apk.ts requires each in the
 * APK's dex; test/kotlin-modules.test.ts checks this list against the modules
 * there, so a new one cannot be left out of the check.
 */
export const KOTLIN_MODULES = ['CindlFocus', 'CindlLoopback', 'CindlScreen'] as const
