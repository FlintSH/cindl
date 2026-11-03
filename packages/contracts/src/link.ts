import { z } from 'zod'

/** Which Hermes session authority protocol the connection negotiated. */
export const AuthorityMode = z.enum(['canonical', 'legacy-sidecar-v8'])
export type AuthorityMode = z.infer<typeof AuthorityMode>

export const ServerIdentity = z.object({
  /** Origin of the `hermes serve` backend, e.g. `https://hermes.example.test`. */
  origin: z.string(),
  hermesVersion: z.string().optional(),
  desktopBackendContract: z.number().int().optional(),
  authority: AuthorityMode.optional(),
  /** True only when the handshake proved one session authority across surfaces. */
  sessionAuthority: z.boolean().optional(),
  /** Version outside the verified baseline: capabilities are negotiated only. */
  untestedVersion: z.boolean().optional(),
})
export type ServerIdentity = z.infer<typeof ServerIdentity>

export const LinkPhase = z.enum([
  'unconfigured',
  'signed-out',
  'connecting',
  'online',
  'reconnecting',
  'offline',
  'incompatible',
  'error',
])
export type LinkPhase = z.infer<typeof LinkPhase>

export const AuthMethod = z.enum(['same-origin-cookie', 'native-pkce', 'demo-fixture'])
export type AuthMethod = z.infer<typeof AuthMethod>

export const LinkState = z.object({
  phase: LinkPhase,
  server: ServerIdentity.optional(),
  auth: AuthMethod.optional(),
  /** ISO time the phase was entered. */
  since: z.iso.datetime(),
  /** Increments on every (re)connected RPC socket; open requests are tied to it. */
  connectionEpoch: z.number().int().nonnegative(),
  /** Hermes replay epoch from `gateway.ready`; a change means history must be reconciled. */
  replayEpoch: z.string().optional(),
  lastError: z.object({ code: z.string(), message: z.string() }).optional(),
  /** Set when running against synthetic fixtures; the UI must show a banner. */
  demo: z.boolean().optional(),
})
export type LinkState = z.infer<typeof LinkState>
