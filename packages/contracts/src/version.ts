/**
 * Version of the Cindl client contract (this package). Bump on any breaking
 * change to a schema, event or operation, and follow the contract-change
 * protocol in packages/contracts/AGENTS.md.
 */
export const CONTRACTS_VERSION = 2

/**
 * The Hermes release this contract was verified against. Other versions are
 * treated as untested: the adapter only enables capabilities it can negotiate.
 */
export const HERMES_BASELINE = {
  version: '0.22.5',
  tag: 'v0.22.5',
  commit: 'bf0203a794a07aac3ff764972ab9087baa4e4f4e',
  desktopBackendContract: 8,
} as const
