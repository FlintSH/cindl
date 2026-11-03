/**
 * TEST-ONLY state of the fake Hermes host. Everything is SYNTHETIC and
 * labelled "(fixture)": no real people, accounts, files or hosts. Host paths
 * the real server would expose use the fictional `/srv/hermes-fixture` root
 * so tests can prove Cindl never forwards them.
 */
import { createHash, randomBytes } from 'node:crypto'

export const FIXTURE_HOME = '/srv/hermes-fixture/.hermes'

export interface TranscriptRow {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  timestamp: number
  row_id: number
  name?: string
  context?: string
}

export interface StoredSession {
  id: string
  title: string
  preview: string
  startedAt: number
  source: string
  profile: string
  revision: number
  generation: number
  archived: boolean
  rows: TranscriptRow[]
}

export interface CronJob {
  job_id: string
  name: string
  schedule: string
  enabled: boolean
  state: string
  prompt_preview: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
}

export interface MemoryFiles {
  memory: string[]
  profile: string[]
}

export const MEMORY_LIMITS = { memory: 2200, profile: 1375 } as const
export const ENTRY_DELIMITER = '\n§\n'

/** agent/learning_graph.py `memory_fingerprint`: sha256(entry.strip())[:12]. */
/** Python's `str.strip()` whitespace, which Hermes strips entries with (not `trim()`'s). */
const PYTHON_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PYTHON_STRIP = new RegExp(`^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`, 'g')
export const pyStrip = (text: string) => text.replace(PYTHON_STRIP, '')

/** sha256(entry.strip())[:12] (agent/learning_graph.py:153). */
export const memoryFingerprint = (entry: string) =>
  createHash('sha256').update(pyStrip(entry), 'utf8').digest('hex').slice(0, 12)

export const hex = (bytes: number) => randomBytes(bytes).toString('hex')

export class FixtureProfile {
  readonly name: string
  soul: string
  soulExists: boolean
  readonly memory: MemoryFiles
  readonly limits = { ...MEMORY_LIMITS }
  readonly skills = new Map<
    string,
    { description: string; category: string; enabled: boolean; content: string }
  >()

  constructor(name: string) {
    this.name = name
    this.soul = `# SOUL (fixture)\n\nYou are the ${name} fixture agent for the fictional Larkspur Studio.\n`
    this.soulExists = true
    this.memory = {
      memory: [
        'Studio calendar lives in the shared fixture calendar (synthetic).',
        'Weekly report goes out on Fridays (fixture).',
      ],
      profile: ['The owner prefers short answers (fixture).'],
    }
    this.skills.set('fixture-notes', {
      description: 'Search the synthetic studio notes (fixture).',
      category: 'productivity',
      enabled: true,
      content:
        '---\nname: fixture-notes\n---\n\n# Fixture notes\n\nSearch the synthetic notes.\n',
    })
    this.skills.set('fixture-report', {
      description: 'Draft the weekly synthetic report (fixture).',
      category: 'writing',
      enabled: false,
      content: '---\nname: fixture-report\n---\n\n# Weekly report (fixture)\n',
    })
  }

  memoryBytes(store: keyof MemoryFiles): number {
    return Buffer.byteLength(this.memory[store].join(ENTRY_DELIMITER), 'utf8')
  }
}

export class FixtureStore {
  readonly profiles = new Map<string, FixtureProfile>([
    ['default', new FixtureProfile('default')],
    ['studio', new FixtureProfile('studio')],
  ])
  readonly sessions = new Map<string, StoredSession>()
  readonly receipts = new Map<
    string,
    { digest: string; result: Record<string, unknown> }
  >()
  readonly cron: CronJob[] = [
    {
      job_id: 'fixture-job-1',
      name: 'Morning digest (fixture)',
      schedule: '0 8 * * *',
      enabled: true,
      state: 'scheduled',
      prompt_preview: 'Summarise the synthetic inbox.',
      next_run_at: '2026-06-03T08:00:00+00:00',
      last_run_at: '2026-06-02T08:00:03+00:00',
      last_status: 'ok',
    },
    {
      job_id: 'fixture-job-2',
      name: 'Backup check (fixture)',
      schedule: 'every 6h',
      enabled: false,
      state: 'paused',
      prompt_preview: 'Check the synthetic backups.',
      next_run_at: null,
      last_run_at: '2026-06-01T12:00:00+00:00',
      last_status: 'error',
    },
  ]
  display = {
    supported: true,
    installed: true,
    running: true,
    holder: 'agent' as 'agent' | 'human',
    holderViewerId: undefined as string | undefined,
    since: 1_780_000_000,
    epoch: 0,
  }
  readonly mcp = [
    {
      name: 'fixture-notes',
      transport: 'stdio',
      tools: 3,
      connected: true,
      disabled: false,
      status: 'connected',
      source: 'config',
    },
    {
      name: 'fixture-calendar',
      transport: 'http',
      tools: 0,
      connected: false,
      disabled: false,
      status: 'failed',
      source: 'config',
    },
  ]

  /**
   * The profile `hermes -p <name> serve` runs as. An omitted, empty or
   * `current` profile means this one, never `default`
   * (web_server_profiles.py:31-34).
   */
  served = 'default'

  profile(name: string | undefined): FixtureProfile {
    return this.profiles.get(
      name && name !== 'current' ? name : this.served,
    ) as FixtureProfile
  }

  /** Profiles that profile-scoped requests named other than the served one. */
  readonly otherProfileScopes: string[] = []

  /** Test control: serve another profile, creating it when it is new. */
  serveAs(name: string): FixtureProfile {
    if (!this.profiles.has(name)) this.profiles.set(name, new FixtureProfile(name))
    this.served = name
    return this.profile(name)
  }

  /** `YYYYMMDD_HHMMSS_<6 hex>` like hermes_state_ids.py. */
  newSessionId(nowMs: number): string {
    const d = new Date(nowMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(
      d.getUTCHours(),
    )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}_${hex(3)}`
  }

  seedSession(
    nowMs: number,
    title: string,
    rows: Array<Omit<TranscriptRow, 'row_id' | 'timestamp'>>,
  ) {
    const id = this.newSessionId(nowMs)
    const started = nowMs / 1000
    const session: StoredSession = {
      id,
      title,
      preview: rows.find((r) => r.role === 'user')?.text.slice(0, 80) ?? '',
      startedAt: started,
      source: 'tui',
      profile: 'default',
      revision: 1,
      generation: 1,
      archived: false,
      rows: rows.map((row, index) => ({
        ...row,
        row_id: index + 1,
        timestamp: started + index,
      })),
    }
    this.sessions.set(id, session)
    return session
  }
}

/** Profile names Hermes accepts (hermes_cli/profiles.py validate_profile_name, simplified). */
export const validProfileName = (name: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)
