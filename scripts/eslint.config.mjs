// Lint for repository tooling, spreading the root config (ESLint uses the
// nearest eslint.config.* for each file). Gates load workspace TypeScript
// (contracts, shortcuts, fixture markers) from --root so their tests can point
// them at throwaway fixture repositories, which needs computed dynamic
// imports. Scripts never ship in a client, so the root rule against computed
// imports (it guards fixture loading in product code) is lifted here; every
// other rule applies unchanged.
import root, { cindlRules } from '../eslint.config.mjs'

const COMPUTED_IMPORT = "ImportExpression:not([source.type='Literal'])"
const [level, ...selectors] = cindlRules.rules['no-restricted-syntax']
const kept = selectors.filter((entry) => entry.selector !== COMPUTED_IMPORT)
if (kept.length === selectors.length)
  throw new Error(
    'scripts/eslint.config.mjs: the root computed-import rule changed; update it',
  )

export default [
  ...root,
  {
    files: ['**/*.mjs'],
    rules: {
      // Command-line tools print by design (the root override is root-relative).
      'no-console': 'off',
      'no-restricted-syntax': [level, ...kept],
    },
  },
]
