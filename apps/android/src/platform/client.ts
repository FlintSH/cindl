import type { CindlClientApi } from '@cindl/contracts'

export type ClientResolution =
  | { kind: 'demo'; api: CindlClientApi }
  | { kind: 'unavailable'; reason: 'transport-pending' }

/**
 * Picks the client for this build. There is no silent fallback to fixtures:
 * the SYNTHETIC demo runs only when the APK was built with
 * EXPO_PUBLIC_CINDL_DEMO=1 (inlined at bundle time; metro.config.cjs leaves
 * the fixtures out of every other bundle), and it always shows a banner.
 *
 * The direct Hermes client (`createDirectClient`, transport stream) is not
 * in this baseline yet. When it lands, real builds resolve to
 * `createDirectClient(await createAndroidPlatform())`; see
 * docs/handbook/clients/android.md.
 */
export async function resolveClient(): Promise<ClientResolution> {
  if (process.env.EXPO_PUBLIC_CINDL_DEMO === '1') {
    const { createScenarioClient } = await import('@cindl/fixtures/scenario')
    return { kind: 'demo', api: createScenarioClient() }
  }
  return { kind: 'unavailable', reason: 'transport-pending' }
}
