import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'tokens', include: ['test/**/*.test.{ts,tsx}'] },
})
