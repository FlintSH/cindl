// Android lint rules: the root config plus React Native specifics. ESLint 10
// resolves the nearest config per file, so this file governs apps/android.
// Rule lists extend the root's (cindlRules) instead of replacing them.
import globals from 'globals'
import tseslint from 'typescript-eslint'
import root, { cindlRules } from '../../eslint.config.mjs'

const [, ...rootSyntax] = cindlRules.rules['no-restricted-syntax']
const [, ...rootGlobals] = cindlRules.rules['no-restricted-globals']
const isFixtureImportRule = (entry) => String(entry.selector).includes('ImportExpression')

const androidSyntax = [
  {
    selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
    message: 'Use semantic colours from useTheme(); raw colours live in @cindl/tokens.',
  },
  {
    selector: 'Literal[value=/^(?:rgb|hsl)a?\\(/]',
    message: 'Use semantic colours from useTheme(); raw colours live in @cindl/tokens.',
  },
]

export default tseslint.config(
  ...root,
  { ignores: ['android/**', '.expo/**', 'dist/**', 'dist-*/**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'index.ts', 'modules/**/*.ts'],
    rules: {
      // React Native has no DOM; DOM types exist only for the shared packages.
      'no-restricted-globals': [
        'error',
        ...rootGlobals,
        { name: 'document', message: 'React Native has no DOM.' },
        { name: 'window', message: 'React Native has no window object.' },
      ],
      'no-restricted-syntax': ['error', ...rootSyntax, ...androidSyntax],
    },
  },
  {
    // The explicit, build-flag-gated demo switch may load the synthetic scenario.
    files: ['src/platform/client.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': [
        'error',
        ...rootSyntax.filter((entry) => !isFixtureImportRule(entry)),
        ...androidSyntax,
      ],
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
)
