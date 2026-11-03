import { PendingPrompt } from '@cindl/contracts'
import { z } from 'zod'
import type { KeyValueStore } from '../platform.ts'

/**
 * What the direct client keeps on the device, per Hermes origin, in the
 * platform's non-secret KeyValueStore: the prompt outbox, the ledger of
 * requests this device answered, the connection-epoch counter and the
 * device's main-conversation pin. No tokens; those live in the SecretStore.
 */

export const AnsweredEntry = z.object({
  requestId: z.string().min(1),
  /** The exact JSON-RPC result sent, so a lost reply can be re-sent unchanged. */
  result: z.record(z.string(), z.unknown()),
  answeredAt: z.string(),
  epoch: z.number().int().nonnegative(),
})
export type AnsweredEntry = z.infer<typeof AnsweredEntry>

const MAX_ANSWERED = 200

export class DirectStorage {
  readonly #kv: KeyValueStore
  readonly #prefix: string
  readonly #onError: (name: string) => void
  #writes: Promise<void> = Promise.resolve()

  constructor(
    kv: KeyValueStore,
    origin: string,
    onError: (name: string) => void = () => undefined,
  ) {
    this.#kv = kv
    this.#prefix = `cindl.direct.v1|${origin}|`
    this.#onError = onError
  }

  async #read<T>(name: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
    const raw = await this.#kv.get(this.#prefix + name)
    if (raw === undefined) return fallback
    try {
      const parsed = schema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : fallback
    } catch {
      return fallback
    }
  }

  /**
   * Writes are serialized so a slow store never applies an older value last.
   * They never reject: a failed write is reported and the in-memory state
   * stays authoritative for this run.
   */
  #write(name: string, value: unknown): Promise<void> {
    const write = this.#writes
      .then(() => this.#kv.set(this.#prefix + name, JSON.stringify(value)))
      .catch(() => this.#onError(name))
    this.#writes = write
    return write
  }

  loadEpoch() {
    return this.#read('epoch', z.number().int().nonnegative(), 0)
  }

  saveEpoch(epoch: number) {
    return this.#write('epoch', epoch)
  }

  loadMain() {
    return this.#read('main', z.string().min(1).optional(), undefined)
  }

  saveMain(conversationId: string) {
    return this.#write('main', conversationId)
  }

  loadOutbox() {
    return this.#read('outbox', z.array(PendingPrompt), [])
  }

  /** Accepted prompts are Hermes's from then on; only unsettled ones are kept. */
  saveOutbox(prompts: Iterable<PendingPrompt>) {
    return this.#write(
      'outbox',
      [...prompts].filter((p) => p.state !== 'accepted'),
    )
  }

  loadAnswered() {
    return this.#read('answered', z.array(AnsweredEntry), [])
  }

  saveAnswered(entries: Iterable<AnsweredEntry>) {
    return this.#write('answered', [...entries].slice(-MAX_ANSWERED))
  }
}
