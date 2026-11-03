/**
 * TEST-ONLY fake `hermes serve` (Hermes v0.22.5 subset) for the Cindl adapter
 * and direct-client tests. SYNTHETIC data only; binds 127.0.0.1 on a random
 * port; never contacts anything. It is not Hermes and must never be used as a
 * production fallback (AGENTS.md privacy invariant 5).
 *
 * Emulated in gated mode (an auth provider is configured, as when
 * `dashboard.public_url` or a non-loopback bind engages the gate):
 * - REST: status, providers, me, ws-ticket, native authorize/token/refresh,
 *   password login (cookie), session mutation snapshot/patch, skills, SOUL,
 *   memory metadata and per-entry memory (learning routes).
 * - WS `/api/ws`: ticket (subprotocol or `?ticket=`) or `?token=` bearer auth,
 *   then Host/Origin checks; refusals before accept reach the client as
 *   HTTP 403, which is how uvicorn delivers a pre-accept close.
 * - WS `/api/display/ws`: display ticket checked after accept (close 4401).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  FakeAuth,
  FIXTURE_LOGIN,
  FIXTURE_OWNER,
  validateLoopbackRedirect,
  type FakeSession,
} from './auth.ts'
import { HermesContract } from './contract.ts'
import { FakeGateway, type FakeCall } from './gateway.ts'
import {
  ENTRY_DELIMITER,
  FIXTURE_HOME,
  FixtureStore,
  hex,
  memoryFingerprint,
  pyStrip,
  validProfileName,
  type FixtureProfile,
  type MemoryFiles,
} from './store.ts'

export interface FakeHermesOptions {
  /** `gated` (default): auth provider required. `loopback`: per-process token mode Cindl refuses. */
  mode?: 'gated' | 'loopback'
  /** Extra trusted host (the hostname of `dashboard.public_url`). */
  publicHost?: string
  /** Advertise `session_authority` (canonical protocol) in gateway.ready. */
  sessionAuthority?: boolean
  /** What the synthetic browser leg of native sign-in does. */
  nativeSignIn?: 'approve' | 'deny'
  version?: string
  /** Serve the per-entry memory routes (/api/learning/*). Default true; false answers 404. */
  learningRoutes?: boolean
}

export interface FakeHermes {
  readonly origin: string
  readonly port: number
  readonly store: FixtureStore
  readonly auth: FakeAuth
  readonly gateway: FakeGateway
  readonly contract: HermesContract
  /** Every request received: REST `METHOD /path`, RPC method names, WS paths. Never bodies. */
  readonly calls: FakeCall[]
  /** Frames that did not match the vendored contract. Tests expect this to stay empty. */
  readonly violations: string[]
  readonly loopbackToken: string
  nativeSignIn: 'approve' | 'deny'
  now(): number
  /** Move the fake's clock forward (ticket, code and token expiry). */
  advance(ms: number): void
  /** A synthetic signed-in session, as the password login would mint. */
  signIn(): FakeSession
  /** Test control: the next `METHOD /path` request answers `status` instead of being handled. */
  failNextRest(route: string, status: number): void
  close(): Promise<void>
}

type Json = Record<string, unknown>

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
}
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** web_server_boundary.py `_host_header_hostname`. */
function hostOf(authority: string): string {
  const value = authority.trim()
  if (!value || value.includes('://') || /["'<> \n\r\t/?#@]/.test(value)) return ''
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close < 0) return ''
    const host = value.slice(1, close)
    if (!host.includes(':')) return ''
    const suffix = value.slice(close + 1)
    if (suffix && !/^:\d+$/.test(suffix)) return ''
    return host.toLowerCase()
  }
  if ((value.match(/:/g) ?? []).length > 1) return ''
  if (value.includes(':')) {
    const [host, port] = [
      value.slice(0, value.lastIndexOf(':')),
      value.slice(value.lastIndexOf(':') + 1),
    ]
    if (!host || !/^\d+$/.test(port)) return ''
    return host.toLowerCase()
  }
  return value.toLowerCase()
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

function bearer(req: IncomingMessage): string {
  const [scheme, value] = (req.headers.authorization ?? '').split(' ', 2)
  return scheme?.trim().toLowerCase() === 'bearer' && value ? value.trim() : ''
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2_000_000) reject(new Error('body too large'))
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

class HttpError extends Error {
  readonly status: number
  readonly body: Json
  constructor(status: number, body: Json) {
    super(String(status))
    this.status = status
    this.body = body
  }
}

const detail = (status: number, message: string) =>
  new HttpError(status, { detail: message })

export async function startFakeHermes(
  options: FakeHermesOptions = {},
): Promise<FakeHermes> {
  let offset = 0
  const clock = { now: () => Date.now() + offset }
  const mode = options.mode ?? 'gated'
  const store = new FixtureStore()
  const auth = new FakeAuth(clock)
  const contract = new HermesContract()
  const calls: FakeCall[] = []
  const violations: string[] = []
  const gateway = new FakeGateway({ store, auth, contract, clock, calls, violations })
  gateway.sessionAuthority = options.sessionAuthority === true
  const loopbackToken = hex(16)
  const trusted = new Set([
    ...LOOPBACK_HOSTS,
    ...(options.publicHost ? [options.publicHost] : []),
  ])
  const hostAccepted = (header: string | undefined) => trusted.has(hostOf(header ?? ''))
  const selectedProtocol = new WeakMap<IncomingMessage, string>()

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (_protocols, req) => selectedProtocol.get(req) ?? false,
  })

  // --- REST auth ------------------------------------------------------------

  const unauthorized = (reason: string) =>
    new HttpError(401, {
      error:
        reason === 'invalid_or_expired_session' ? 'session_expired' : 'unauthenticated',
      detail: 'Unauthorized',
      reason,
      login_url: '/login',
    })

  const requireSession = (req: IncomingMessage, res: ServerResponse): FakeSession => {
    if (mode === 'loopback') {
      // Loopback mode: one per-process token, no sessions (web_server.py:443-463).
      const token =
        (req.headers['x-hermes-session-token'] as string | undefined) ?? bearer(req)
      if (token !== loopbackToken) throw detail(401, 'Unauthorized')
      return {
        accessToken: '',
        refreshToken: '',
        expiresAt: 0,
        refreshExpiresAt: 0,
        provider: 'loopback',
        userId: 'local',
      }
    }
    const presented = bearer(req)
    if (presented) {
      const session = auth.verifyAccess(presented)
      if (!session) throw unauthorized('invalid_or_expired_session')
      return session
    }
    const jar = cookies(req)
    const at = jar.hermes_session_at
    const rt = jar.hermes_session_rt
    if (!at && !rt) throw unauthorized('no_cookie')
    const session = auth.verifyAccess(at)
    if (session) return session
    const rotated = rt ? auth.refresh(rt) : undefined
    if (!rotated) throw unauthorized('invalid_or_expired_session')
    setSessionCookies(res, rotated)
    return rotated
  }

  const setSessionCookies = (res: ServerResponse, session: FakeSession) =>
    res.setHeader('Set-Cookie', [
      `hermes_session_at=${session.accessToken}; HttpOnly; SameSite=Lax; Path=/`,
      `hermes_session_rt=${session.refreshToken}; HttpOnly; SameSite=Lax; Path=/`,
      `hermes_session_provider=${session.provider}; HttpOnly; SameSite=Lax; Path=/`,
    ])

  // --- profile scoping (web_server_profiles.py:190-199, 277-307) ------------

  const scopedProfile = (name: string | null | undefined): FixtureProfile => {
    if (!name || name === 'current') return store.profile(undefined)
    if (!validProfileName(name))
      throw detail(400, `Invalid profile name: ${JSON.stringify(name)}`)
    const profile = store.profiles.get(name)
    if (!profile) throw detail(404, `Profile '${name}' does not exist.`)
    return profile
  }

  /**
   * `?profile=` or a body `profile` on a profile-scoped route (`_profile_scope`).
   * Naming a profile other than the served one switches Hermes to
   * multi-profile hosting and loads that profile's secrets
   * (web_server_profiles.py:296-311), so the fake records it.
   */
  const profileScope = (name: string | null | undefined): FixtureProfile => {
    const profile = scopedProfile(name)
    if (profile.name !== store.served) store.otherProfileScopes.push(profile.name)
    return profile
  }

  // --- learning routes (agent/learning_mutations.py) ------------------------

  const cards = (profile: FixtureProfile) => [
    ...profile.memory.memory.map((entry) => ({ source: 'memory' as const, entry })),
    ...profile.memory.profile.map((entry) => ({ source: 'profile' as const, entry })),
  ]

  const parseMemoryId = (
    id: string,
  ): { source: keyof MemoryFiles; index: number; fingerprint: string } => {
    const [kind, source, index, fingerprint, ...extra] = id.split(':')
    if (
      kind !== 'memory' ||
      (source !== 'memory' && source !== 'profile') ||
      !/^-?\d+$/.test(index ?? '') ||
      extra.length
    )
      throw new Error(`bad memory node id: '${id}'`)
    return { source, index: Number(index), fingerprint: fingerprint ?? '' }
  }

  const locate = (profile: FixtureProfile, id: string) => {
    const { source, index, fingerprint } = parseMemoryId(id)
    const entries = profile.memory[source]
    if (fingerprint) {
      const local = entries.findIndex((entry) => memoryFingerprint(entry) === fingerprint)
      if (local < 0) throw new Error('memory node id is stale — refresh the graph')
      return { source, local }
    }
    // Legacy positional id: resolved by position alone.
    const all = cards(profile)
    if (index < 0 || index >= all.length)
      throw new Error(`memory index ${index} out of range`)
    if (all[index]?.source !== source)
      throw new Error('memory node id is stale — refresh the graph')
    const local = source === 'memory' ? index : index - profile.memory.memory.length
    return { source, local }
  }

  const mutateMemory = (
    profile: FixtureProfile,
    id: string,
    replacement: string | null,
  ): Json => {
    const { source, local } = locate(profile, id)
    const limit = profile.limits[source]
    const entries = profile.memory[source]
    const file = source === 'memory' ? 'MEMORY.md' : 'USER.md'
    if (entries.some((entry) => entry.length > limit))
      return {
        ok: false,
        message: `Refusing to write ${file}: it holds an entry larger than the whole store's char limit. A snapshot was saved to ${FIXTURE_HOME}/memories/${file}.bak.${Math.floor(clock.now() / 1000)}. Resolve the drift first.`,
      }
    const next = [...entries]
    if (replacement === null) next.splice(local, 1)
    else next[local] = replacement
    const total = next.join(ENTRY_DELIMITER).length
    if (replacement !== null && total > limit)
      return {
        ok: false,
        message: `Replacement would put memory at ${total.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} chars. Shorten the new content.`,
      }
    profile.memory[source] = next
    return {
      ok: true,
      message:
        replacement === null
          ? `deleted memory from ${file}`
          : `updated memory in ${file}`,
    }
  }

  const learningMutation = (fn: () => Json, status: number, fallback: string): Json => {
    let result: Json
    try {
      result = fn()
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : fallback }
    }
    if (!result.ok)
      throw detail(status, typeof result.message === 'string' ? result.message : fallback)
    return result
  }

  // --- routes -----------------------------------------------------------------

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<unknown> {
    const method = req.method ?? 'GET'
    const path = url.pathname
    const json = async (): Promise<Json> => {
      const raw = await readBody(req)
      try {
        const value = raw ? (JSON.parse(raw) as unknown) : {}
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          throw new Error()
        return value as Json
      } catch {
        throw new HttpError(422, { detail: [{ type: 'json_invalid', loc: ['body'] }] })
      }
    }
    const required = (body: Json, ...keys: string[]) => {
      const missing = keys.filter((key) => typeof body[key] !== 'string')
      if (missing.length)
        throw new HttpError(422, {
          detail: missing.map((key) => ({ type: 'missing', loc: ['body', key] })),
        })
    }

    if (method === 'GET' && path === '/api/status')
      return {
        version: options.version ?? '0.22.5',
        release_date: '2026-10-28',
        config_version: 1,
        latest_config_version: 1,
        gateway_running: false,
        active_sessions: gateway.live.size,
        auth_required: mode === 'gated',
        auth_providers: mode === 'gated' ? ['basic'] : [],
        auth_flows: mode === 'gated' ? ['cookie', 'native_pkce'] : [],
        nous_session_valid: 'unknown',
        overall: 'ok',
        profiles: [...store.profiles.keys()],
        gateway_mode: 'standalone',
        // Loopback-only recon fields (status.py:573-577); Cindl must never forward them.
        ...(mode === 'loopback'
          ? {
              hermes_home: FIXTURE_HOME,
              config_path: `${FIXTURE_HOME}/config.yaml`,
              gateway_pid: 4242,
            }
          : {}),
      }
    if (method === 'GET' && path === '/api/auth/providers')
      return {
        providers: [
          { name: 'basic', display_name: 'Password (fixture)', supports_password: true },
        ],
      }
    if (method === 'GET' && path === '/auth/native/authorize') {
      const query = url.searchParams
      if ((query.get('code_challenge_method') ?? '').toUpperCase() !== 'S256')
        throw detail(400, 'code_challenge_method must be S256')
      const challenge = query.get('code_challenge') ?? ''
      if (!challenge) throw detail(400, 'code_challenge required')
      let redirect: string
      try {
        redirect = validateLoopbackRedirect(query.get('redirect_uri') ?? '')
      } catch (error) {
        throw detail(400, error instanceof Error ? error.message : 'bad redirect_uri')
      }
      const state = query.get('state') ?? ''
      if (fake.nativeSignIn === 'deny') {
        const separator = redirect.includes('?') ? '&' : '?'
        res.writeHead(302, {
          Location: `${redirect}${separator}${new URLSearchParams({ error: 'access_denied', state }).toString()}`,
        })
        res.end()
        return undefined
      }
      // Synthetic browser leg: the fixture owner "signs in" at once.
      const location = auth.completePending(
        auth.registerPending(challenge, redirect, state),
      )
      res.writeHead(302, { Location: location })
      res.end()
      return undefined
    }
    if (method === 'POST' && path === '/auth/native/token') {
      const body = await json()
      required(body, 'code', 'code_verifier')
      const session = auth.redeem(String(body.code), String(body.code_verifier))
      if (!session) throw detail(400, 'Invalid or expired authorization code.')
      return bearerPayload(session)
    }
    if (method === 'POST' && path === '/auth/native/refresh') {
      const body = await json()
      required(body, 'refresh_token')
      if (!body.refresh_token) throw detail(400, 'refresh_token required')
      if (auth.refreshUnavailable) throw detail(503, "Auth provider 'basic' unreachable")
      const session = auth.refresh(
        typeof body.refresh_token === 'string' ? body.refresh_token : '',
      )
      if (!session)
        throw new HttpError(401, {
          error: 'session_expired',
          detail: 'Refresh token expired or invalid; start a new sign-in.',
        })
      return bearerPayload(session)
    }
    if (method === 'POST' && path === '/auth/password-login') {
      const body = await json()
      if (
        body.username !== FIXTURE_LOGIN.username ||
        body.password !== FIXTURE_LOGIN.password
      )
        throw detail(401, 'Invalid credentials')
      setSessionCookies(res, auth.mintSession())
      return { ok: true, next: '/' }
    }
    if (!path.startsWith('/api/')) throw detail(404, 'Not Found')

    const session = requireSession(req, res)

    if (method === 'GET' && path === '/api/auth/me')
      return { ...FIXTURE_OWNER, user_id: session.userId, expires_at: session.expiresAt }
    if (method === 'POST' && path === '/api/auth/ws-ticket') {
      // routes.py:556-564: needs a gated session; loopback mode has none.
      if (mode === 'loopback') throw detail(401, 'Unauthorized')
      return {
        ticket: auth.mintTicket({ userId: session.userId, provider: session.provider }),
        ttl_seconds: auth.ticketTtlSeconds,
      }
    }

    const sessionPath = /^\/api\/sessions\/([^/]+)(\/mutation-snapshot)?$/.exec(path)
    if (sessionPath) {
      const id = decodeURIComponent(sessionPath[1] ?? '')
      const stored = store.sessions.get(id)
      if (method === 'GET' && sessionPath[2])
        return {
          session_id: id,
          exists: Boolean(stored),
          runtime_revision: stored?.revision ?? 0,
          runtime_generation: stored?.generation ?? null,
        }
      if (method === 'PATCH' && !sessionPath[2]) {
        const body = await json()
        const requestId = body.request_id
        const expected = body.expected_revision
        if (
          requestId === undefined &&
          expected === undefined &&
          body.expected_generation === undefined
        )
          throw detail(409, 'client_upgrade_required')
        if (typeof requestId !== 'string' || typeof expected !== 'number')
          throw detail(409, 'mutation_identity_required')
        const payload = Object.fromEntries(
          ['title', 'archived', 'hidden', 'pinned', 'unread']
            .filter((key) => body[key] !== undefined && body[key] !== null)
            .map((key) => [key, body[key]]),
        )
        const digest = JSON.stringify({
          id,
          payload,
          expected,
          generation: body.expected_generation,
        })
        const receipt = store.receipts.get(`${session.userId}|${id}|${requestId}`)
        if (receipt) {
          if (receipt.digest !== digest) throw detail(409, 'request_id_reused')
          return { ok: true, ...receipt.result }
        }
        if (!stored) throw detail(404, 'not_found')
        if (stored.revision !== expected) throw detail(409, 'revision_conflict')
        if (
          typeof body.expected_generation === 'number' &&
          body.expected_generation !== stored.generation
        )
          throw detail(409, 'stale_generation')
        if (typeof payload.title === 'string') stored.title = payload.title
        if (typeof payload.archived === 'boolean') stored.archived = payload.archived
        stored.revision += 1
        const result = {
          session_id: id,
          revision: stored.revision,
          execution_generation: stored.generation,
          operation: 'sidebar',
        }
        store.receipts.set(`${session.userId}|${id}|${requestId}`, { digest, result })
        return { ok: true, ...result }
      }
    }

    if (path === '/api/skills' && method === 'GET') {
      const profile = profileScope(url.searchParams.get('profile'))
      return [...profile.skills].map(([name, skill]) => ({
        name,
        description: skill.description,
        category: skill.category,
        enabled: skill.enabled,
        usage: 0,
        provenance: 'agent',
      }))
    }
    if (path === '/api/skills/content' && method === 'GET') {
      const name = url.searchParams.get('name')
      if (!name)
        throw new HttpError(422, {
          detail: [{ type: 'missing', loc: ['query', 'name'] }],
        })
      const skill = profileScope(url.searchParams.get('profile')).skills.get(name)
      if (!skill) throw detail(404, `Skill '${name}' not found.`)
      return {
        name,
        content: skill.content,
        path: `${FIXTURE_HOME}/skills/${name}/SKILL.md`,
      }
    }
    if (path === '/api/skills/content' && method === 'PUT') {
      const body = await json()
      required(body, 'name', 'content')
      const profile = profileScope(
        typeof body.profile === 'string' ? body.profile : url.searchParams.get('profile'),
      )
      const skill = profile.skills.get(String(body.name))
      if (!skill) throw detail(404, `Skill '${String(body.name)}' not found.`)
      if (String(body.content).length > 100_000)
        throw detail(400, 'SKILL.md content exceeds 100,000 characters.')
      skill.content = String(body.content)
      return {
        success: true,
        message: `Skill '${String(body.name)}' updated (full rewrite).`,
      }
    }
    const soulPath = /^\/api\/profiles\/([^/]+)\/soul$/.exec(path)
    if (soulPath) {
      const profile = scopedProfile(decodeURIComponent(soulPath[1] ?? ''))
      if (method === 'GET')
        return {
          content: profile.soulExists ? profile.soul : '',
          exists: profile.soulExists,
        }
      if (method === 'PUT') {
        const body = await json()
        required(body, 'content')
        profile.soul = String(body.content)
        profile.soulExists = true
        return { ok: true }
      }
    }
    if (path === '/api/memory' && method === 'GET') {
      const profile = profileScope(url.searchParams.get('profile'))
      return {
        active: '',
        providers: [
          {
            name: 'fixture-provider',
            description: 'Synthetic provider (fixture).',
            available: false,
            missing: false,
          },
        ],
        builtin_files: {
          memory: profile.memoryBytes('memory'),
          user: profile.memoryBytes('profile'),
        },
      }
    }
    if (path.startsWith('/api/learning/') && options.learningRoutes === false)
      throw detail(404, 'Not Found')
    if (path === '/api/learning/graph' && method === 'GET') {
      const profile = profileScope(url.searchParams.get('profile'))
      const memory = cards(profile).map(({ source, entry }, index) => {
        const first =
          entry
            .split('\n')[0]
            ?.trim()
            .replace(/^#+\s*/, '') ?? ''
        return {
          source,
          timestamp: Math.floor(clock.now() / 1000) + index,
          title: first.length > 80 ? `${first.slice(0, 80)}…` : first,
          body: entry.slice(0, 1200),
          fingerprint: memoryFingerprint(entry),
        }
      })
      return {
        nodes: memory.map((card, index) => ({
          id: `memory:${card.source}:${index}:${card.fingerprint}`,
          label: card.title,
          kind: 'memory',
          memorySource: card.source,
          timestamp: card.timestamp,
          category: 'memory',
          useCount: 0,
          state: 'active',
          createdBy: 'memory',
          pinned: false,
        })),
        edges: [],
        clusters: memory.length ? [{ category: 'memory', count: memory.length }] : [],
        memory,
        stats: { memory_nodes: memory.length, memory_skill_edges: 0, learned_skills: 0 },
      }
    }
    if (path === '/api/learning/node') {
      if (method === 'GET') {
        const id = url.searchParams.get('id')
        if (!id)
          throw new HttpError(422, {
            detail: [{ type: 'missing', loc: ['query', 'id'] }],
          })
        const profile = profileScope(url.searchParams.get('profile'))
        return learningMutation(
          () => {
            if (!id.startsWith('memory:')) {
              const skill = profile.skills.get(id)
              if (!skill) return { ok: false, message: `skill '${id}' not found` }
              return { ok: true, kind: 'skill', id, label: id, content: skill.content }
            }
            const { source, local } = locate(profile, id)
            const content = pyStrip(profile.memory[source][local] ?? '')
            return {
              ok: true,
              kind: 'memory',
              id,
              label: content.split('\n')[0]?.slice(0, 80) ?? '',
              content,
            }
          },
          404,
          'not found',
        )
      }
      if (method === 'PUT' || method === 'DELETE') {
        const body = await json()
        required(body, ...(method === 'PUT' ? ['id', 'content'] : ['id']))
        const profile = profileScope(
          typeof body.profile === 'string'
            ? body.profile
            : url.searchParams.get('profile'),
        )
        const id = String(body.id)
        return learningMutation(
          () => {
            if (!id.startsWith('memory:')) {
              // Skill namespace on the same route (learning_mutations.py:182-207).
              if (!profile.skills.has(id))
                return { ok: false, message: `skill '${id}' not found` }
              if (method === 'DELETE') {
                profile.skills.delete(id)
                return { ok: true, message: `archived '${id}'` }
              }
              const skill = profile.skills.get(id)
              if (skill) skill.content = String(body.content)
              return { ok: true, message: `updated '${id}'` }
            }
            if (method === 'DELETE') return mutateMemory(profile, id, null)
            parseMemoryId(id)
            const content = pyStrip(String(body.content))
            if (!content)
              return { ok: false, message: 'empty memory — use delete to remove it' }
            return mutateMemory(profile, id, content)
          },
          400,
          method === 'PUT' ? 'edit failed' : 'delete failed',
        )
      }
    }
    throw detail(404, 'Not Found')
  }

  const bearerPayload = (session: FakeSession) => ({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    token_type: 'Bearer',
    expires_at: session.expiresAt,
    provider: session.provider,
    user_id: session.userId,
  })

  /** One-shot REST failures by `METHOD /path` (failNextRest). */
  const restFailures = new Map<string, number>()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-hermes.invalid')
    const name = `${req.method ?? 'GET'} ${url.pathname}`
    calls.push({ kind: 'rest', name })
    const send = (status: number, body: unknown) => {
      if (res.headersSent) return
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }
    if (!hostAccepted(req.headers.host)) {
      send(400, { detail: 'Invalid host header' })
      return
    }
    const failure = restFailures.get(name)
    if (failure !== undefined) {
      restFailures.delete(name)
      send(failure, { detail: 'Internal Server Error' })
      return
    }
    route(req, res, url)
      .then((body) => {
        if (body !== undefined) send(200, body)
      })
      .catch((error: unknown) => {
        if (error instanceof HttpError) send(error.status, error.body)
        else send(500, { detail: 'Internal Server Error' })
      })
  })

  // --- WebSocket upgrades -----------------------------------------------------

  const refuse = (socket: Socket, status: number) => {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    )
    socket.destroy()
  }

  /** web_server_boundary.py ws_host_origin_reason. */
  const originAllowed = (req: IncomingMessage) => {
    if (!hostAccepted(req.headers.host)) return false
    const origin = req.headers.origin
    if (!origin) return true
    // Non-web origins (packaged Electron's `null`, file://, app://) are
    // trusted; the credential is the boundary there. A malformed web origin
    // fails closed.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(origin)?.[1]?.toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return true
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    return hostAccepted(parsed.host)
  }

  /** web_server_chat.py `_ws_auth_reason` (gated) and the loopback `?token=` check. */
  const gatewayAuth = (
    req: IncomingMessage,
    url: URL,
  ): { ok: boolean; protocol?: string } => {
    if (mode === 'loopback')
      return { ok: url.searchParams.get('token') === loopbackToken }
    const raw = String(req.headers['sec-websocket-protocol'] ?? '')
    const protocols = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const ticketProtocols = protocols.filter((p) =>
      p.startsWith('hermes-gateway-ticket.'),
    )
    let protocolTicket = ''
    if (ticketProtocols.length) {
      if (!protocols.includes('hermes-gateway-v1') || ticketProtocols.length !== 1)
        return { ok: false }
      protocolTicket = (ticketProtocols[0] as string).slice(
        'hermes-gateway-ticket.'.length,
      )
      if (!protocolTicket) return { ok: false }
    }
    const ticket = protocolTicket || url.searchParams.get('ticket') || ''
    if (ticket) {
      const info = auth.consumeTicket(ticket)
      if (!info || info.provider === 'bot-desktop') return { ok: false }
      return protocolTicket ? { ok: true, protocol: 'hermes-gateway-v1' } : { ok: true }
    }
    const token = url.searchParams.get('token')
    if (token) return { ok: Boolean(auth.verifyAccess(token)) }
    return { ok: false }
  }

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://fake-hermes.invalid')
    calls.push({ kind: 'ws', name: url.pathname })
    if (url.pathname === '/api/ws') {
      // Order as chat_ws.py `_close_unless_sidecar_allowed`: auth, then Host/Origin.
      const authResult = gatewayAuth(req, url)
      if (!authResult.ok || !originAllowed(req)) {
        refuse(socket, 403)
        return
      }
      if (authResult.protocol) selectedProtocol.set(req, authResult.protocol)
      wss.handleUpgrade(req, socket, head, (ws) => gateway.attach(ws))
      return
    }
    if (url.pathname === '/api/display/ws') {
      if (!originAllowed(req)) {
        refuse(socket, 403)
        return
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const info = auth.consumeTicket(url.searchParams.get('display_ticket') ?? '')
        if (!info || info.provider !== 'bot-desktop') {
          ws.close(4401, 'display ticket missing, expired or used')
          return
        }
        if (!store.display.running) {
          ws.close(4001, 'Bot Desktop is not running')
          return
        }
        gateway.attachDisplayViewer(ws, info.viewerId ?? '')
      })
      return
    }
    refuse(socket, 404)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const fake: FakeHermes = {
    origin: `http://127.0.0.1:${port}`,
    port,
    store,
    auth,
    gateway,
    contract,
    calls,
    violations,
    loopbackToken,
    nativeSignIn: options.nativeSignIn ?? 'approve',
    now: () => clock.now(),
    advance(ms) {
      offset += ms
    },
    signIn: () => auth.mintSession(),
    failNextRest(route, status) {
      restFailures.set(route, status)
    },
    async close() {
      gateway.restart()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  return fake
}

/**
 * Test helper: close every fake, then fail if any saw a frame that broke the
 * vendored contract. Closing first means a violation never leaves a fake (or
 * the fakes after it) listening until the test worker exits.
 */
export async function closeFakes(fakes: Iterable<FakeHermes>): Promise<void> {
  const violations: string[] = []
  for (const fake of fakes) {
    try {
      await fake.close()
    } finally {
      violations.push(...fake.violations)
    }
  }
  if (violations.length)
    throw new Error(
      `fake Hermes frames must match the vendored contract:\n${violations.join('\n')}`,
    )
}
