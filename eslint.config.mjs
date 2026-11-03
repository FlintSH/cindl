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

// --- Synthetic fixtures never reach production code (AGENTS.md invariant 5) ---

/** Fixture module paths, bare or relative, with any number of slashes. */
const fixturePath = '/(@cindl\\/+fixtures|packages\\/+fixtures|fixtures\\/+src)/'
const fixtureMessage =
  'Synthetic fixtures are for tests and the labelled demo switch only.'
const noFixtureDynamicImport = {
  selector: `ImportExpression[source.value=${fixturePath}]`,
  message: fixtureMessage,
}
/** apps/web/src/platform/client.ts: only the demo switch's exact import. */
const onlyDemoSwitchImport = {
  selector: `ImportExpression[source.value=${fixturePath}]:not([source.value='@cindl/fixtures/scenario'])`,
  message: fixtureMessage,
}
const noFixtureRequire = {
  selector: `CallExpression[callee.name='require'][arguments.0.value=${fixturePath}]`,
  message: fixtureMessage,
}
/** Vite can pull files into a bundle without an import: globs and asset URLs. */
const noFixtureBundling = [
  {
    selector:
      "CallExpression[callee.object.type='MetaProperty'][callee.property.name=/^glob/]",
    message:
      'List modules explicitly; import.meta.glob can pull in fixtures or any file.',
  },
  {
    selector: `NewExpression[callee.name='URL'][arguments.0.value=${fixturePath}]`,
    message: fixtureMessage,
  },
]
/** Bundled code only: Vite turns a computed `new URL(…, import.meta.url)` into a glob. */
const noComputedAssetUrl = {
  selector:
    "NewExpression[callee.name='URL'][arguments.1.object.type='MetaProperty']:not([arguments.0.type='Literal'])",
  message: 'Asset URLs relative to import.meta.url must use a literal path.',
}
/** A computed dynamic import could load anything, fixtures included. */
const noComputedImport = {
  selector: "ImportExpression:not([source.type='Literal'])",
  message: 'Dynamic imports must use a literal module path.',
}
const fixtureImports = {
  patterns: [
    {
      group: [
        '@cindl/fixtures',
        '@cindl/fixtures/*',
        '**/@cindl/fixtures',
        '**/@cindl/fixtures/**',
        '**/packages/fixtures',
        '**/packages/fixtures/**',
        '**/fixtures/src',
        '**/fixtures/src/**',
      ],
      message: fixtureMessage,
    },
    {
      // Repeated slashes (packages//fixtures) slip past the glob patterns above.
      regex: '(@cindl/+fixtures|packages/+fixtures|fixtures/+src)',
      message: fixtureMessage,
    },
  ],
}

// --- Tokens and private data never go to browser storage (AGENTS.md invariant 3) ---

const storageMessage =
  'Use apps/web/src/platform/preferences.ts (non-secret preferences only).'
const STORAGE = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'cookie',
  'caches',
  'cookieStore',
]
const namesPattern = (names) => `/^(${names.join('|')})$/`
/** Global objects whose properties include storage. `top`/`parent` are left out: locals use those names. */
const globalObjects = '/^(window|globalThis|self|document|navigator)$/'

/** Routes to the named properties that the global and property rules cannot see. */
const storageBypass = (names) => [
  {
    selector: `MemberExpression[computed=true][property.value=${namesPattern(names)}]`,
    message: 'Browser storage and cookies are off limits (computed access included).',
  },
  {
    selector: `ObjectPattern > Property[key.name=${namesPattern(names)}]`,
    message: 'Browser storage and cookies are off limits (destructuring included).',
  },
  {
    selector: `CallExpression[callee.property.name=/^(get|getOwnPropertyDescriptor|defineProperty)$/][arguments.1.value=${namesPattern(names)}]`,
    message:
      'Browser storage and cookies are off limits (Reflect and descriptors included).',
  },
]
/** Ways to reach any property of a global object without naming it. */
const noGlobalReach = [
  {
    selector:
      "MemberExpression[property.name='cookie'][object.type='MemberExpression'][object.property.name='document']",
    message: 'Cindl never reads or writes cookies itself.',
  },
  {
    selector: `MemberExpression[computed=true][object.name=${globalObjects}]:not([property.type='Literal'])`,
    message: 'No computed property access on global objects; it can reach storage.',
  },
  {
    selector: "MemberExpression[computed=true][object.property.name='defaultView']",
    message: 'No computed property access on global objects; it can reach storage.',
  },
  {
    selector: `VariableDeclarator[init.type='Identifier'][init.name=${globalObjects}]`,
    message:
      'Use global objects directly, never through an alias the storage rules cannot see.',
  },
  {
    selector: "VariableDeclarator[init.property.name='defaultView']",
    message:
      'Use global objects directly, never through an alias the storage rules cannot see.',
  },
  {
    selector: `CallExpression[callee.object.name='Reflect'][arguments.0.name=${globalObjects}]`,
    message: 'No Reflect calls on global objects; they can reach storage.',
  },
  {
    selector:
      "CallExpression[callee.object.name='Reflect'][arguments.0.property.name='defaultView']",
    message: 'No Reflect calls on global objects; they can reach storage.',
  },
  {
    selector: `CallExpression[callee.object.name='Object'][callee.property.name=/^(getOwnPropertyDescriptors?|defineProperty|defineProperties)$/][arguments.0.name=${globalObjects}]`,
    message: 'No property descriptors of global objects; they can reach storage.',
  },
  {
    selector:
      "CallExpression[callee.object.name='Object'][callee.property.name=/^(getOwnPropertyDescriptors?|defineProperty|defineProperties)$/][arguments.0.object.name=/^(Document|HTMLDocument|Window|Navigator|Storage)$/]",
    message: 'No property descriptors of DOM prototypes; they can reach storage.',
  },
  {
    selector:
      "MemberExpression[property.name='storage'][object.property.name='navigator']",
    message: 'Do not persist data in browser storage (navigator.storage).',
  },
]
/**
 * The same property through any object: window.window, (0, window),
 * document.defaultView, top. Browser-facing sources only: Node code has
 * legitimate `cookie` fields (HTTP headers, cookie options).
 */
const storageMember = (names) => ({
  selector: `MemberExpression[computed=false][property.name=${namesPattern(names)}]`,
  message: 'Browser storage and cookies are off limits (through any object or alias).',
})
const restrictedGlobals = (names) =>
  [
    { name: 'localStorage', message: storageMessage },
    { name: 'sessionStorage', message: 'Do not persist data in sessionStorage.' },
    { name: 'indexedDB', message: 'Do not persist data in IndexedDB.' },
    { name: 'caches', message: 'Do not persist data in the Cache API.' },
    { name: 'cookieStore', message: 'Cindl never reads or writes cookies itself.' },
  ].filter((entry) => names.includes(entry.name))
const restrictedProperties = (names) => [
  ...['window', 'globalThis', 'self'].flatMap((object) =>
    [
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
    ].filter((entry) => names.includes(entry.property)),
  ),
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
]

/** Every file, scripts and tests included. */
const invariantSyntax = [
  noRawHtml,
  noFixtureDynamicImport,
  noFixtureRequire,
  ...noFixtureBundling,
  noComputedImport,
  ...storageBypass(STORAGE),
]
/**
 * Sources that ship add the asset-URL rule and the global-reach rules (Node
 * scripts and tests legitimately stub globals); browser-facing sources also
 * get the any-object rule.
 */
const bundledSyntax = [...invariantSyntax, noComputedAssetUrl, ...noGlobalReach]
const browserSyntax = [...bundledSyntax, storageMember(STORAGE)]
const BUNDLED = ['apps/*/src/**', 'packages/*/src/**']
const BROWSER = [
  'apps/web/src/**',
  'packages/client-core/src/**',
  'packages/client-react/src/**',
  'packages/contracts/src/**',
  'packages/tokens/src/**',
]

/** Rules that encode Cindl invariants. Each ties to an AGENTS.md rule and has a test in apps/web/test/lint-rules.test.ts. */
export const cindlRules = {
  rules: {
    'no-restricted-imports': ['error', fixtureImports],
    'no-restricted-globals': ['error', ...restrictedGlobals(STORAGE)],
    'no-restricted-properties': ['error', ...restrictedProperties(STORAGE)],
    'no-restricted-syntax': ['error', ...invariantSyntax],
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

// ESLint replaces a rule's options per matching block, so each scope below
// lists its complete syntax rules, from the widest scope to the narrowest.
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
  { files: BUNDLED, rules: { 'no-restricted-syntax': ['error', ...bundledSyntax] } },
  { files: BROWSER, rules: { 'no-restricted-syntax': ['error', ...browserSyntax] } },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Tests and the fixtures package itself may use fixtures.
    files: ['packages/fixtures/**', '**/test/**', '**/e2e/**'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': [
        'error',
        noRawHtml,
        noComputedImport,
        ...storageBypass(STORAGE),
      ],
    },
  },
  {
    // The demo switch: one literal import of the labelled scenario, nothing else.
    files: ['apps/web/src/platform/client.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...browserSyntax.filter((rule) => rule !== noFixtureDynamicImport),
        onlyDemoSwitchImport,
      ],
    },
  },
  {
    // The one module allowed to use localStorage (non-secret preferences); every
    // other storage API stays off limits here too.
    files: ['apps/web/src/platform/preferences.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...restrictedGlobals(STORAGE.filter((n) => n !== 'localStorage')),
      ],
      'no-restricted-properties': [
        'error',
        ...restrictedProperties(STORAGE.filter((n) => n !== 'localStorage')),
      ],
      'no-restricted-syntax': [
        'error',
        noRawHtml,
        noFixtureDynamicImport,
        noFixtureRequire,
        ...noFixtureBundling,
        noComputedImport,
        noComputedAssetUrl,
        ...storageBypass(STORAGE.filter((n) => n !== 'localStorage')),
        ...noGlobalReach,
        storageMember(STORAGE.filter((n) => n !== 'localStorage')),
      ],
    },
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
