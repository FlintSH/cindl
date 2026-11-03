import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'hermes-adapter', include: ['test/**/*.test.{ts,tsx}'] },
})
