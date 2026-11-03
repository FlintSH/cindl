import { PendingPrompt } from '@cindl/contracts'
import { z } from 'zod'
import type { KeyValueStore } from '../platform.ts'

/**
 * What the direct client keeps on the device, per Hermes origin, in the
 * platform's non-secret KeyValueStore: the prompt outbox, the client ids of
 * prompts Hermes already accepted (so a retried submit is never sent twice),
 * the connection-epoch counter and the device's main-conversation pin. No
 * tokens (those live in the SecretStore) and no request answers: Hermes's
 * `open_requests` is the record of what is still unanswered.
 */

const MAX_ACCEPTED = 500

export class DirectStorage {
  readonly #kv: KeyValueStore
  readonly #prefix: string
  readonly #onError: (name: string) => void
  #writes: Promise<boolean> = Promise.resolve(true)

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
    let raw: string | undefined
    try {
      raw = await this.#kv.get(this.#prefix + name)
    } catch {
      this.#onError(name)
      return fallback
    }
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
   * They resolve false instead of rejecting when the store fails, so callers
   * that must not proceed without a durable record can check.
   */
  #write(name: string, value: unknown): Promise<boolean> {
    const write = this.#writes.then(() =>
      this.#kv.set(this.#prefix + name, JSON.stringify(value)).then(
        () => true,
        () => {
          this.#onError(name)
          return false
        },
      ),
    )
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

  loadAccepted() {
    return this.#read('accepted', z.array(z.string().min(1)), [])
  }

  saveAccepted(clientIds: Iterable<string>) {
    return this.#write('accepted', [...clientIds].slice(-MAX_ACCEPTED))
  }
}
