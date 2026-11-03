import { defineConfig } from 'vitest/config'

// `pnpm test` runs every workspace package that has a vitest.config.ts. A new
// package joins by adding its own config; it never needs to edit this file.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
})
