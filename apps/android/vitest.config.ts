import { defineProject } from 'vitest/config'

// Pure logic only (navigation, sign-in orchestration, Markdown model, storage
// encoding). React Native components are exercised on the emulator in CI.
export default defineProject({
  test: { name: 'android', environment: 'node', include: ['test/**/*.test.ts'] },
})
