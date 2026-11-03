import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against the production build of the SYNTHETIC demo
 * (dist-demo) served by `vite preview` on loopback, with the production CSP.
 * They exercise real UI and client-core code; they do not prove live Hermes
 * behaviour. Set CINDL_E2E_CHANNEL=chrome to use an installed Chrome instead
 * of Playwright's bundled Chromium, and CINDL_E2E_PORT to move off port 4173.
 */
const channel = process.env.CINDL_E2E_CHANNEL
// Another checkout on the same machine may hold the default port; never share it.
const port = Number(process.env.CINDL_E2E_PORT ?? '4173')
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('CINDL_E2E_PORT must be a port number from 1024 to 65535.')
const origin = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  outputDir: '../../.agent-artifacts/web-e2e-results',
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: {
    command: `pnpm run build:demo && pnpm exec vite preview --outDir dist-demo --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    // Never test whatever happens to be listening on the port (shared machines).
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
