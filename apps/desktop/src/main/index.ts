/**
 * Entry point of the real Cindl desktop app. It bundles no synthetic data
 * and has no demo switch: it talks to your `hermes serve` through the direct
 * client (see session.ts). Cindl Demo is a separate build from demo.ts
 * (ADR 0011).
 */
import { runCindl } from './app.ts'
import { createRealClient } from './session.ts'

runCindl({
  kind: 'real',
  async createClient({ createPlatform, confirmSignIn, log }) {
    const platform = await createPlatform()
    if (platform.secrets.persistence === 'memory-only')
      log.warn('Hermes tokens will be kept in memory only', {
        reason: platform.secrets.reason,
      })
    return createRealClient(platform, { confirmSignIn, log })
  },
})
