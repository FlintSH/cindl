import { CindlError } from '@cindl/contracts'
import type { RestClient } from './rest.ts'

/**
 * Individual memory entries (MEMORY.md "agent notes" and USER.md "user
 * profile") through Hermes v0.22.5's learning routes
 * (hermes_cli/web_routers/status.py:693-743, agent/learning_mutations.py):
 *
 *   GET    /api/learning/graph            memory cards: source, title, body (≤1200 chars), fingerprint
 *   GET    /api/learning/node?id=         full entry text
 *   PUT    /api/learning/node {id, content}
 *   DELETE /api/learning/node {id}
 *
 * The node id `memory:<store>:<index>:<fingerprint>` carries
 * `sha256(entry.strip())[:12]`. Hermes resolves it by that fingerprint under
 * the memory store's file lock and refuses the write when the entry changed,
 * which makes the id itself the per-entry compare-and-swap version. Legacy ids
 * without a fingerprint resolve by position and are refused here, as is any
 * id outside the `memory:` namespace (those address skills on the same routes).
 *
 * Hermes keeps no backup of an edited or deleted entry (tools/memory_tool_store.py:
 * `_write_file` replaces the file atomically; a `.bak` snapshot is written only
 * when it refuses a drifted file). Deletion is permanent.
 *
 * Not exposed through `CindlClientApi` yet: the operations await a contract
 * change (memory.text). Never use filesystem routes as a substitute.
 */

export type MemoryStoreName = 'memory' | 'profile'

export interface MemoryEntrySummary {
  id: string
  store: MemoryStoreName
  fingerprint: string
  title: string
  /** Hermes's card body: the entry text, truncated to 1200 characters. */
  preview: string
  truncated: boolean
}

export interface MemoryEntryDocument {
  id: string
  store: MemoryStoreName
  fingerprint: string
  content: string
  readAt: string
  source: string
}

export interface MemoryEntriesOptions {
  rest: RestClient
  /** Lowercase hex SHA-256 of UTF-8 text (client-core `sha256Hex`). */
  sha256Hex: (text: string) => string
  now: () => string
}

const ENTRY_ID = /^memory:(memory|profile):(\d+):([a-f0-9]{12})$/
const PREVIEW_LIMIT = 1200

export interface ParsedMemoryEntryId {
  store: MemoryStoreName
  index: number
  fingerprint: string
}

/** Accepts only fingerprinted memory ids; positional and skill ids are refused. */
export function parseMemoryEntryId(id: string): ParsedMemoryEntryId {
  const match = ENTRY_ID.exec(id)
  if (!match) {
    const positional = /^memory:(memory|profile):\d+$/.test(id)
    throw new CindlError(
      'invalid',
      positional
        ? 'That memory reference is out of date. Reload the memory list.'
        : 'That is not a memory entry reference.',
      positional ? 'positional memory id refused' : 'not a fingerprinted memory id',
    )
  }
  return {
    store: match[1] as MemoryStoreName,
    index: Number(match[2]),
    fingerprint: match[3] as string,
  }
}

export function memoryFingerprint(sha256Hex: (text: string) => string, text: string) {
  return sha256Hex(text.trim()).slice(0, 12)
}

/** Map a learning-route failure to a Cindl error without echoing Hermes's text (it can hold host paths). */
function classify(error: unknown, label: string): unknown {
  if (!(error instanceof CindlError)) return error
  const detail = error.detail ?? ''
  const status = /HTTP (\d{3})/.exec(detail)?.[1] ?? '?'
  const at = (kind: string) => `${label}: HTTP ${status} (${kind})`
  if (/stale/i.test(detail))
    return new CindlError(
      'conflict',
      'This memory entry changed since you read it. Reload it and review again.',
      at('stale id'),
    )
  if (/Replacement would put memory at/i.test(detail)) {
    const usage = /([\d,]+)\/([\d,]+) chars/.exec(detail)
    return new CindlError(
      'invalid',
      usage
        ? `That would put memory at ${usage[1]} of ${usage[2]} characters. Shorten it.`
        : 'That is longer than Hermes allows for memory. Shorten it.',
      at('over limit'),
    )
  }
  if (/empty memory/i.test(detail))
    return new CindlError(
      'invalid',
      'A memory entry cannot be empty. Delete it instead.',
      at('empty'),
    )
  if (/Refusing to write/i.test(detail))
    return new CindlError(
      'conflict',
      'Hermes refused to rewrite this memory file because it was edited outside Hermes. Resolve that on the Hermes host first.',
      at('external drift'),
    )
  if (/Profile .* does not exist/i.test(detail))
    return new CindlError(
      'not-found',
      'That Hermes profile does not exist.',
      at('profile'),
    )
  if (error.code === 'not-found' || /not found/i.test(detail))
    return new CindlError(
      'not-found',
      'That memory entry no longer exists.',
      at('not found'),
    )
  if (error.code === 'invalid')
    return new CindlError('invalid', 'Hermes rejected the memory change.', at('rejected'))
  return new CindlError(error.code, error.message, at(error.code))
}

export class MemoryEntries {
  readonly #options: MemoryEntriesOptions

  constructor(options: MemoryEntriesOptions) {
    this.#options = options
  }

  async list(profile?: string): Promise<MemoryEntrySummary[]> {
    let graph
    try {
      graph = await this.#options.rest.learningGraph(profile)
    } catch (error) {
      throw classify(error, 'GET /api/learning/graph')
    }
    // Node ids enumerate the memory cards in order (agent/learning_graph.py:156-158, 238-245).
    return (graph.memory ?? []).map((card, index) => ({
      id: `memory:${card.source}:${index}:${card.fingerprint}`,
      store: card.source,
      fingerprint: card.fingerprint,
      title: card.title,
      preview: card.body,
      truncated: card.body.length >= PREVIEW_LIMIT,
    }))
  }

  async read(id: string, profile?: string): Promise<MemoryEntryDocument> {
    const parsed = parseMemoryEntryId(id)
    let node
    try {
      node = await this.#options.rest.learningNode(id, profile)
    } catch (error) {
      throw classify(error, 'GET /api/learning/node')
    }
    if (memoryFingerprint(this.#options.sha256Hex, node.content) !== parsed.fingerprint)
      throw new CindlError(
        'conflict',
        'This memory entry changed since it was listed. Reload the memory list.',
        'fingerprint mismatch on read',
      )
    return {
      id,
      store: parsed.store,
      fingerprint: parsed.fingerprint,
      content: node.content,
      readAt: this.#options.now(),
      source: 'GET /api/learning/node',
    }
  }

  /**
   * Replace one entry. `id` must be the exact fingerprinted id that was read;
   * Hermes refuses it if the entry changed meanwhile. Returns the entry under
   * its new id (the fingerprint follows the text).
   */
  async write(
    id: string,
    content: string,
    options: { confirm: true; profile?: string },
  ): Promise<MemoryEntryDocument> {
    if (options.confirm !== true)
      throw new CindlError('invalid', 'Confirm the reviewed change before saving.')
    const parsed = parseMemoryEntryId(id)
    const body = content.trim()
    if (!body)
      throw new CindlError(
        'invalid',
        'A memory entry cannot be empty. Delete it instead.',
      )
    try {
      await this.#options.rest.writeLearningNode(id, body, options.profile)
    } catch (error) {
      throw classify(error, 'PUT /api/learning/node')
    }
    const fingerprint = memoryFingerprint(this.#options.sha256Hex, body)
    return {
      id: `memory:${parsed.store}:${parsed.index}:${fingerprint}`,
      store: parsed.store,
      fingerprint,
      content: body,
      readAt: this.#options.now(),
      source: 'PUT /api/learning/node',
    }
  }

  /** Delete one entry permanently. Hermes keeps no backup, so there is no undo. */
  async delete(
    id: string,
    options: { confirm: true; profile?: string },
  ): Promise<{ deleted: true; recoverable: false }> {
    if (options.confirm !== true)
      throw new CindlError('invalid', 'Confirm the deletion first.')
    parseMemoryEntryId(id)
    try {
      await this.#options.rest.deleteLearningNode(id, options.profile)
    } catch (error) {
      throw classify(error, 'DELETE /api/learning/node')
    }
    return { deleted: true, recoverable: false }
  }
}
