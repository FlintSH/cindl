import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'client-core', include: ['test/**/*.test.{ts,tsx}'] },
})
