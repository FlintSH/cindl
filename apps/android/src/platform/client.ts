import type { CindlClientApi } from '@cindl/contracts'
import { createAndroidPlatform } from './android.ts'
import { createAndroidClient, type AndroidClient } from './direct.ts'

export type ClientResolution =
  { kind: 'demo'; api: CindlClientApi } | { kind: 'direct'; client: AndroidClient }

/**
 * Picks the client for this build. There is no silent fallback to fixtures:
 * the SYNTHETIC demo runs only when the APK was built with
 * EXPO_PUBLIC_CINDL_DEMO=1 (inlined at bundle time; metro.config.cjs leaves
 * the fixtures out of every other bundle), and it always shows a banner.
 * Every other build talks to Hermes through the direct client.
 */
export async function resolveClient(): Promise<ClientResolution> {
  if (process.env.EXPO_PUBLIC_CINDL_DEMO === '1') {
    const { createScenarioClient } = await import('@cindl/fixtures/scenario')
    return { kind: 'demo', api: createScenarioClient() }
  }
  return {
    kind: 'direct',
    client: await createAndroidClient(await createAndroidPlatform()),
  }
}
