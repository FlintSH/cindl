// Android lint rules: the root config plus React Native specifics. ESLint 10
// resolves the nearest config per file, so this file governs apps/android.
// The root's rule options apply here unchanged; Android's own checks are the
// `cindl-android` rules (lint/rules.mjs). Tests: test/lint-rules.test.ts.
import globals from 'globals'
import tseslint from 'typescript-eslint'
import root from '../../eslint.config.mjs'
import android from './lint/rules.mjs'

/**
 * The root's options for `rule` in the scope that lists `glob`. The root
 * exports no scoped lists, so they are found by a glob it names; a lookup that
 * finds nothing stops lint rather than leave Android with weaker rules.
 */
function rootRule(glob, rule) {
  const block = root.findLast((b) => b.files?.includes(glob) && b.rules?.[rule])
  if (!block)
    throw new Error(
      `apps/android/eslint.config.mjs: the root config no longer scopes ${rule} for ${glob}; update this file.`,
    )
  return block.rules[rule]
}

/** Code in the app bundle. */
const SHIPPED = ['src/**/*.{ts,tsx}', 'index.ts', 'modules/**/*.ts']

export default [
  ...root,
  {
    // The Android rules for everything that ships. The root already applies its
    // bundled and browser scopes to these files (eslint.config.mjs BUNDLED and
    // BROWSER); the browser scope's syntax rule is repeated here unchanged, so
    // this app keeps it if the root's lists change.
    files: SHIPPED,
    plugins: { 'cindl-android': android },
    rules: {
      'no-restricted-syntax': rootRule('apps/web/src/**', 'no-restricted-syntax'),
      'cindl-android/no-dom-globals': 'error',
      'cindl-android/no-raw-colour': 'error',
      'cindl-android/storage-in-platform': 'error',
      // Press is built on Pressable; an overlay's scrim is no control: its taps
      // close the overlay that a noted press opened. These two files only.
      'cindl-android/no-bare-pressable': [
        'error',
        { builtOn: ['src/ui/Press.tsx', 'src/overlay/Scrim.tsx'] },
      ],
    },
  },
  {
    // The platform layer is where the device's storage is opened.
    files: ['src/platform/**'],
    rules: { 'cindl-android/storage-in-platform': 'off' },
  },
  {
    // The demo switch: one literal import of the labelled scenario, nothing else,
    // under the same rules as the web's switch.
    files: ['src/platform/client.ts'],
    rules: {
      'no-restricted-syntax': rootRule(
        'apps/web/src/platform/client.ts',
        'no-restricted-syntax',
      ),
    },
  },
  {
    // The emulator test harness is a command-line tool and prints by design.
    files: ['e2e/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // The bundle gate reads the fixture marker list; it never ships in the app.
    files: ['scripts/check-bundle.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['metro.config.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]
