// Root lint rules. ESLint 10 resolves the nearest eslint.config.* for each
// file, so an app with extra needs (Electron main, React Native) adds its own
// config that spreads this one instead of editing it.
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export const ignores = {
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/dist-*/**',
    '**/coverage/**',
    '.agent-artifacts/**',
    'packages/hermes-adapter/upstream/**',
    'packages/tokens/generated/**',
    'apps/android/android/**',
    'apps/android/.expo/**',
    'docs/handbook/.vitepress/cache/**',
    'docs/handbook/.vitepress/dist/**',
  ],
}

const noRawHtml = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message: 'Render agent content through talk/Markdown.tsx; raw HTML is never rendered.',
}
const noFixtureDynamicImport = {
  selector:
    'ImportExpression[source.value=/(^@cindl\\/fixtures|packages\\/fixtures|fixtures\\/src)/]',
  message: 'Synthetic fixtures are for tests and the labelled demo switch only.',
}
const storageMessage =
  'Use apps/web/src/platform/preferences.ts (non-secret preferences only).'
const storageNames =
  '/^(localStorage|sessionStorage|indexedDB|cookie|caches|cookieStore)$/'
/** Forms that would bypass no-restricted-properties/globals (computed access, destructuring). */
const noStorageBypass = [
  {
    selector: `MemberExpression[computed=true][property.value=${storageNames}]`,
    message: 'Browser storage and cookies are off limits (computed access included).',
  },
  {
    selector:
      "MemberExpression[property.name='cookie'][object.type='MemberExpression'][object.property.name='document']",
    message: 'Cindl never reads or writes cookies itself.',
  },
  {
    selector: `ObjectPattern > Property[key.name=${storageNames}]`,
    message: 'Browser storage and cookies are off limits (destructuring included).',
  },
]
const noFixtureRequire = {
  selector:
    "CallExpression[callee.name='require'][arguments.0.value=/(^@cindl\\/fixtures|packages\\/fixtures)/]",
  message: 'Synthetic fixtures are for tests and the labelled demo switch only.',
}
/** A computed dynamic import could load anything, fixtures included. */
const noComputedImport = {
  selector: "ImportExpression:not([source.type='Literal'])",
  message: 'Dynamic imports must use a literal module path.',
}

/** Rules that encode Cindl invariants. Each ties to an AGENTS.md rule and has a test in apps/web/test/lint-rules.test.ts. */
export const cindlRules = {
  rules: {
    // Synthetic fixtures never reach production code paths (AGENTS.md: invariant 5).
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '@cindl/fixtures',
              '@cindl/fixtures/*',
              '**/packages/fixtures',
              '**/packages/fixtures/**',
              '**/fixtures/src',
              '**/fixtures/src/**',
            ],
            message:
              'Synthetic fixtures are for tests and the labelled demo switch only.',
          },
        ],
      },
    ],
    // Tokens and private data never go to browser storage (AGENTS.md: invariant 3).
    'no-restricted-globals': [
      'error',
      { name: 'localStorage', message: storageMessage },
      { name: 'sessionStorage', message: 'Do not persist data in sessionStorage.' },
      { name: 'indexedDB', message: 'Do not persist data in IndexedDB.' },
      { name: 'caches', message: 'Do not persist data in the Cache API.' },
      { name: 'cookieStore', message: 'Cindl never reads or writes cookies itself.' },
    ],
    'no-restricted-properties': [
      'error',
      ...['window', 'globalThis', 'self'].flatMap((object) => [
        { object, property: 'localStorage', message: storageMessage },
        {
          object,
          property: 'sessionStorage',
          message: 'Do not persist data in sessionStorage.',
        },
        { object, property: 'indexedDB', message: 'Do not persist data in IndexedDB.' },
        { object, property: 'caches', message: 'Do not persist data in the Cache API.' },
        {
          object,
          property: 'cookieStore',
          message: 'Cindl never reads or writes cookies itself.',
        },
      ]),
      {
        object: 'navigator',
        property: 'storage',
        message: 'Do not persist data in browser storage.',
      },
      {
        object: 'document',
        property: 'cookie',
        message: 'Cindl never reads or writes cookies itself.',
      },
    ],
    // Agent output is untrusted: never inject raw HTML.
    'no-restricted-syntax': [
      'error',
      noRawHtml,
      noFixtureDynamicImport,
      noFixtureRequire,
      noComputedImport,
      ...noStorageBypass,
    ],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-console': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      },
    ],
  },
}

export default tseslint.config(
  ignores,
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.mjs', '*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  cindlRules,
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // The explicit, build-flag-gated demo switch and tests may use fixtures.
    files: [
      'packages/fixtures/**',
      '**/test/**',
      '**/e2e/**',
      'apps/web/src/platform/client.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', noRawHtml, noComputedImport, ...noStorageBypass],
    },
  },
  {
    files: ['apps/web/src/platform/preferences.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-globals': 'off' },
  },
  {
    // Command-line tools print by design.
    files: ['**/scripts/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
)
