import { defineConfig } from '@playwright/test'

/**
 * Launch smoke tests for the Electron app (e2e/smoke.spec.ts). One Electron
 * instance at a time. See e2e/smoke.spec.ts for the environment variables
 * that pick the target (unpacked build or packaged AppImage) and display.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: 'test-results',
})
