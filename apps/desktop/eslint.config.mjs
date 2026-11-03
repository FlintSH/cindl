// The root rules, plus the desktop's build output and the files allowed to
// reach synthetic fixtures. ESLint 10 uses the nearest config for each file,
// so this replaces the root config for apps/desktop.
import root from '../../eslint.config.mjs'

export default [
  // Packaged apps and Playwright output (all git-ignored).
  { ignores: ['release/**', 'test-results/**'] },
  ...root,
  {
    // The Cindl Demo entry point (ADR 0011: labelled demo flavour only) and the
    // output gate, which must know the fixture markers to keep them out of the
    // real flavour.
    files: ['src/main/demo.ts', 'scripts/gates.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
]
