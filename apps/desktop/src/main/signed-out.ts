import {
  CindlError,
  capabilityIds,
  parseOpArgs,
  type CapabilityMap,
  type CindlClientApi,
  type CindlEvent,
  type LinkState,
  type OpName,
} from '@cindl/contracts'

/** Why `auth.signIn` is refused until the direct Hermes client is integrated. */
export const SIGN_IN_PENDING_MESSAGE =
  'This build of Cindl desktop cannot connect to Hermes yet: the live Hermes transport is still being integrated. Nothing was sent.'

const NOT_SIGNED_IN = 'Not signed in to Hermes on this device.'
const NOT_CHECKED = 'Not checked: this device is not signed in to Hermes.'

/**
 * The honest state of a desktop app with no Hermes session: not set up (or
 * signed out of a known origin), every capability unknown with the reason,
 * and every Hermes operation refused. It never invents data. Sign-out still
 * works and is local only.
 */
export function createSignedOutClient(options: {
  /** The Hermes origin this device last signed in to, if any. */
  origin?: string
  /** Forgets any tokens this device holds (local only). */
  forgetTokens(): Promise<void>
  now?: () => number
}): CindlClientApi {
  const now = options.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const link: LinkState = {
    phase: options.origin === undefined ? 'unconfigured' : 'signed-out',
    auth: 'native-pkce',
    since: iso(),
    connectionEpoch: 0,
    ...(options.origin === undefined ? {} : { server: { origin: options.origin } }),
  }
  const capabilities: CapabilityMap = {}
  for (const id of capabilityIds)
    capabilities[id] = {
      id,
      state: 'unknown',
      reason: NOT_CHECKED,
      source: { transport: 'none' },
      checkedAt: link.since,
    }
  const listeners = new Set<(event: CindlEvent) => void>()

  return {
    async call(name, args) {
      parseOpArgs(name, args)
      const op: OpName = name
      switch (op) {
        case 'link.get':
          return link as never
        case 'capabilities.get':
          return capabilities as never
        case 'auth.signIn':
          throw new CindlError('unavailable', SIGN_IN_PENDING_MESSAGE)
        case 'auth.signOut':
          await options.forgetTokens()
          return { localOnly: true } as never
        default:
          throw new CindlError('unauthenticated', NOT_SIGNED_IN)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      queueMicrotask(() => {
        if (!listeners.has(listener)) return
        listener({ type: 'link.changed', link })
        listener({ type: 'capabilities.changed', capabilities })
      })
      return () => listeners.delete(listener)
    },
  }
}
