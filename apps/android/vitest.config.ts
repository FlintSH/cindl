import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Logic (navigation, sign-in orchestration, Markdown model, storage encoding)
// runs in Node. The memory screen's components render with react-dom in jsdom
// (files marked `@vitest-environment jsdom`): React Native's host layer is
// test/render/react-native.tsx, as React Native's Jest preset replaces it, and
// native-only modules are stood in for by test/render. On a device the
// components run on the emulator in CI.
export default defineProject({
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: here('./test/render/react-native.tsx') },
      {
        find: /^react-native-safe-area-context$/,
        replacement: here('./test/render/safe-area.tsx'),
      },
      {
        find: /^lucide-react-native\/icons\/.+$/,
        replacement: here('./test/render/icon.tsx'),
      },
      { find: /^expo$/, replacement: here('./test/render/expo.ts') },
    ],
  },
  test: { name: 'android', environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
})
