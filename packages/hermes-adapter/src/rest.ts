import { CindlError } from '@cindl/contracts'
import type { z } from 'zod'
import { endpointPath, restEndpoints, type RestEndpointName } from './compat.ts'
import { silentDiagnostics, type Diagnostics } from './diagnostics.ts'
import { httpError, offlineError, protocolError, timeoutError } from './errors.ts'
import { parseMemoryEntryId } from './memory-entries.ts'
import type { FetchLike, Timers } from './platform.ts'
import * as wire from './wire.ts'

/**
 * How REST calls authenticate (hermes_cli/dashboard_auth/middleware.py):
 * - `cookie`: the web client mounted on the `hermes serve` origin; Hermes's
 *   HttpOnly session cookie rides along (`credentials: 'same-origin'`). Hermes
 *   has no CSRF tokens; its cookies are `SameSite=Lax`.
 * - `bearer`: native clients (Electron main, Android) send the RFC 8252
 *   access token; on a 401 the client refreshes once and retries once.
 * - `none`: public endpoints only (discovery, native token exchange).
 * Cindl never uses the loopback per-process dashboard token.
 */
export type RestAuth =
  | { kind: 'cookie' }
  | { kind: 'none' }
  | {
      kind: 'bearer'
      accessToken(): Promise<string | undefined>
      /**
       * Rotate tokens after `failedToken` got a 401. Resolves true at once when
       * another request already rotated it; false when Hermes rejected the
       * refresh token.
       */
      refresh(failedToken: string): Promise<boolean>
    }

export interface RestClientOptions {
  origin: string
  fetch: FetchLike
  timers: Timers
  auth: RestAuth
  timeoutMs?: number
  diagnostics?: Diagnostics
}

interface CallOptions<T> {
  pathParams?: Record<string, string>
  query?: Record<string, string | undefined>
  body?: unknown
  schema: z.ZodType<T>
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

export class RestClient {
  readonly origin: string
  readonly #fetch: FetchLike
  readonly #timers: Timers
  readonly #auth: RestAuth
  readonly #timeoutMs: number
  readonly #log: Diagnostics

  constructor(options: RestClientOptions) {
    this.origin = new URL(options.origin).origin
    this.#fetch = options.fetch
    this.#timers = options.timers
    this.#auth = options.auth
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#log = options.diagnostics ?? silentDiagnostics
  }

  get authKind(): RestAuth['kind'] {
    return this.#auth.kind
  }

  status() {
    return this.#call('status', { schema: wire.StatusResponse })
  }

  providers() {
    return this.#call('authProviders', { schema: wire.ProvidersResponse })
  }

  me() {
    return this.#call('authMe', { schema: wire.MeResponse })
  }

  /** Single-use, 30-second WebSocket ticket. Mint a fresh one for every (re)connect. */
  wsTicket() {
    return this.#call('wsTicket', { schema: wire.WsTicketResponse })
  }

  /**
   * POST /auth/logout for a cookie session. Hermes answers only a 302 to
   * /login (routes.py:496-512), which a browser shows as an opaque redirect
   * under `redirect: 'manual'`; anything else is not Hermes confirming it.
   * A proxy in front of Hermes can answer a redirect too, so the direct
   * client then checks that GET /api/auth/me answers 401.
   */
  async logout(): Promise<void> {
    const label = 'POST /auth/logout'
    const { response } = await this.#send(
      'logout',
      { schema: wire.LogoutResponse },
      false,
      label,
    )
    const body = await readBody(response)
    if (response.type === 'opaqueredirect' || response.status === 302) return
    throw httpError(response.status, body.json, label)
  }

  nativeToken(code: string, codeVerifier: string) {
    return this.#call('nativeToken', {
      body: { code, code_verifier: codeVerifier },
      schema: wire.NativeTokenResponse,
    })
  }

  nativeRefresh(refreshToken: string, provider?: string) {
    return this.#call('nativeRefresh', {
      body: provider
        ? { refresh_token: refreshToken, provider }
        : { refresh_token: refreshToken },
      schema: wire.NativeTokenResponse,
    })
  }

  mutationSnapshot(storedId: string, profile?: string) {
    return this.#call('sessionMutationSnapshot', {
      pathParams: { id: storedId },
      query: { profile },
      schema: wire.MutationSnapshot,
    })
  }

  /**
   * Revision-fenced session metadata write. `requestId` makes a retry of the
   * same write safe (Hermes stores a receipt); `expectedRevision` comes from
   * `mutationSnapshot` and is Hermes's server-side compare-and-swap.
   */
  patchSession(
    storedId: string,
    body: {
      request_id: string
      expected_revision: number
      expected_generation?: number
      title?: string
      profile?: string
    },
  ) {
    return this.#call('sessionPatch', {
      pathParams: { id: storedId },
      body,
      schema: wire.SessionPatchResult,
    })
  }

  skills(profile?: string) {
    return this.#call('skills', { query: { profile }, schema: wire.SkillsResponse })
  }

  skillContent(name: string, profile?: string) {
    return this.#call('skillContent', {
      query: { name, profile },
      schema: wire.SkillContentResponse,
    })
  }

  writeSkillContent(name: string, content: string, profile?: string) {
    return this.#call('skillContentWrite', {
      body: profile ? { name, content, profile } : { name, content },
      schema: wire.SkillWriteResponse,
    })
  }

  soul(profileName: string) {
    return this.#call('soul', {
      pathParams: { name: profileName },
      schema: wire.SoulResponse,
    })
  }

  writeSoul(profileName: string, content: string) {
    return this.#call('soulWrite', {
      pathParams: { name: profileName },
      body: { content },
      schema: wire.SoulWriteResponse,
    })
  }

  memory(profile?: string) {
    return this.#call('memory', { query: { profile }, schema: wire.MemoryResponse })
  }

  learningGraph(profile?: string) {
    return this.#call('learningGraph', {
      query: { profile },
      schema: wire.LearningGraphResponse,
    })
  }

  /** Memory entries only: a non-`memory:` or positional id would address a skill or a position. */
  async learningNode(id: string, profile?: string) {
    parseMemoryEntryId(id)
    return this.#call('learningNode', {
      query: { id, profile },
      schema: wire.LearningNodeResponse,
    })
  }

  async writeLearningNode(id: string, content: string, profile?: string) {
    parseMemoryEntryId(id)
    return this.#call('learningNodeWrite', {
      body: profile ? { id, content, profile } : { id, content },
      schema: wire.LearningMutationResponse,
    })
  }

  async deleteLearningNode(id: string, profile?: string) {
    parseMemoryEntryId(id)
    return this.#call('learningNodeDelete', {
      body: profile ? { id, profile } : { id },
      schema: wire.LearningMutationResponse,
    })
  }

  async #call<T>(name: RestEndpointName, options: CallOptions<T>): Promise<T> {
    const endpoint = restEndpoints[name]
    const label = `${endpoint.method} ${endpoint.path}`
    const needsSession = endpoint.auth === 'session'
    if (needsSession && this.#auth.kind === 'none')
      throw new CindlError('unauthenticated', 'Sign in to Hermes first.', label)
    let retried = false
    for (;;) {
      const { response, token } = await this.#send(name, options, needsSession, label)
      if (
        response.status === 401 &&
        needsSession &&
        this.#auth.kind === 'bearer' &&
        token !== undefined &&
        !retried
      ) {
        await readBody(response)
        retried = true
        this.#log.log('info', 'rest.refresh-after-401', { endpoint: label })
        if (await this.#auth.refresh(token)) continue
        throw new CindlError(
          'unauthenticated',
          'Your Hermes sign-in expired. Sign in again.',
          `${label}: HTTP 401 after refresh`,
        )
      }
      return this.#parse(response, options.schema, label)
    }
  }

  async #send<T>(
    name: RestEndpointName,
    options: CallOptions<T>,
    needsSession: boolean,
    label: string,
  ): Promise<{ response: Response; token: string | undefined }> {
    const endpoint = restEndpoints[name]
    const url = new URL(endpointPath(name, options.pathParams), this.origin)
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined && value !== '') url.searchParams.set(key, value)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    let token: string | undefined
    if (needsSession && this.#auth.kind === 'bearer') {
      token = await this.#auth.accessToken()
      if (!token)
        throw new CindlError('unauthenticated', 'Sign in to Hermes first.', label)
      headers.Authorization = `Bearer ${token}`
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = this.#timers.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs ?? this.#timeoutMs)
    const init: RequestInit = {
      method: endpoint.method,
      headers,
      signal: controller.signal,
      credentials: this.#auth.kind === 'cookie' ? 'same-origin' : 'omit',
      cache: 'no-store',
      // Hermes answers API routes with JSON 401s, never redirects; a redirect
      // means a proxy or a non-Hermes origin and surfaces as a protocol error.
      redirect: 'manual',
    }
    if (options.body !== undefined) init.body = JSON.stringify(options.body)
    try {
      const response = await this.#fetch(url.toString(), init)
      this.#log.log('debug', 'rest.response', {
        endpoint: label,
        status: response.status,
      })
      return { response, token }
    } catch (error) {
      if (timedOut) throw timeoutError(`${label}: no response`)
      this.#log.log('warn', 'rest.network-error', {
        endpoint: label,
        error: error instanceof Error ? error.name : 'unknown',
      })
      throw offlineError(`${label}: network error`)
    } finally {
      this.#timers.clearTimeout(timer)
    }
  }

  async #parse<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
    const body = await readBody(response)
    if (!response.ok) throw httpError(response.status, body.json, label)
    if (body.json === undefined) throw protocolError(`${label}: response was not JSON`)
    const parsed = schema.safeParse(body.json)
    if (!parsed.success) throw protocolError(`${label}: unexpected response shape`)
    return parsed.data
  }
}

async function readBody(response: Response): Promise<{ json: unknown }> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return { json: undefined }
  }
  if (!text) return { json: undefined }
  try {
    return { json: JSON.parse(text) as unknown }
  } catch {
    return { json: undefined }
  }
}
