/**
 * Entry point of the real Cindl desktop app. It bundles no synthetic data
 * and has no demo switch: until the direct Hermes client lands it shows the
 * honest signed-out state (see signed-out.ts). Cindl Demo is a separate
 * build from demo.ts (ADR 0011).
 */
import { runCindl } from './app.ts'
import { memoryOnlyNotice } from './platform/index.ts'
import { createSignedOutClient } from './signed-out.ts'

runCindl({
  kind: 'real',
  async createClient({ createPlatform, log }) {
    const platform = await createPlatform()
    const memoryOnly = platform.secrets.persistence === 'memory-only'
    if (memoryOnly)
      log.warn('Hermes tokens will be kept in memory only', {
        reason: platform.secrets.reason,
      })
    const origin = platform.origin()
    return {
      client: createSignedOutClient({
        ...(origin === undefined ? {} : { origin }),
        forgetTokens: async () => {
          await platform.auth.signOut()
        },
      }),
      notices: () =>
        platform.secrets.persistence === 'memory-only'
          ? [memoryOnlyNotice(platform.secrets.reason)]
          : [],
    }
  },
})
