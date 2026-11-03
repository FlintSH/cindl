import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'client-react',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
