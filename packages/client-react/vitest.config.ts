import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'client-react', include: ['test/**/*.test.{ts,tsx}'] },
})
