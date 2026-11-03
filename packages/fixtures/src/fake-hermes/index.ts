/**
 * TEST-ONLY fake Hermes v0.22.5 server. SYNTHETIC data, 127.0.0.1 only.
 * Import from `@cindl/fixtures/fake-hermes` in tests; never from product code.
 */
export {
  FIXTURE_LOGIN,
  FIXTURE_OWNER,
  validateLoopbackRedirect,
  type FakeAuth,
  type FakeSession,
} from './auth.ts'
export {
  connectRawClient,
  nodeBinarySocketFactory,
  nodeSocketFactory,
  type NodeSocketOptions,
  type RawClient,
} from './clients.ts'
export { HermesContract, type ContractCheck } from './contract.ts'
export {
  NOT_SHOWN_MESSAGE,
  OTHER_PROFILE_KEY,
  defaultScript,
  type ClarifyQuestionWire,
  type DisplayViewer,
  type FakeCall,
  type FakeGateway,
  type SettledRequest,
  type TurnContext,
  type TurnScript,
} from './gateway.ts'
export { startFakeHermes, type FakeHermes, type FakeHermesOptions } from './server.ts'
export {
  FIXTURE_HOME,
  MEMORY_LIMITS,
  memoryFingerprint,
  type FixtureStore,
} from './store.ts'
export { RfbClientFilter } from './rfb-filter.ts'
