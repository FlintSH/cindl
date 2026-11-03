import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against the production build of the SYNTHETIC demo
 * (dist-demo) served by `vite preview` on loopback, with the production CSP.
 * They exercise real UI and client-core code; they do not prove live Hermes
 * behaviour. Set CINDL_E2E_CHANNEL=chrome to use an installed Chrome instead
 * of Playwright's bundled Chromium.
 */
const channel = process.env.CINDL_E2E_CHANNEL
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  outputDir: '../../.agent-artifacts/web-e2e-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
    command:
      'pnpm run build:demo && pnpm exec vite preview --outDir dist-demo --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    // Never test whatever happens to be listening on the port (shared machines).
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
