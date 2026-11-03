/**
 * TEST-ONLY. Validates fake-Hermes frames against the vendored Hermes v0.22.5
 * contract subset (packages/hermes-adapter/upstream/v0.22.5), so the fake
 * cannot drift from the real wire contract and the adapter is checked for
 * sending only parameters Hermes accepts.
 */
import subset from '@cindl/hermes-adapter/upstream/v0.22.5/contract-subset.json' with { type: 'json' }
import { Ajv, type ValidateFunction } from 'ajv'

interface Entry {
  name: string
  params?: Array<{ name: string; schema: unknown }>
  result?: { schema: unknown }
}

const CONTRACT_ID = 'urn:cindl:hermes-v0.22.5'

export interface ContractCheck {
  ok: boolean
  /** Human-readable errors (paths and messages only, never payload values). */
  errors: string[]
  /** True when the only failures are unknown keys, which Hermes answers with 4000. */
  unknownKeysOnly: boolean
}

export class HermesContract {
  readonly #ajv: Ajv
  readonly #cache = new Map<string, ValidateFunction>()
  readonly #index = new Map<string, string>()

  constructor() {
    this.#ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
    this.#ajv.addSchema({ ...subset, $id: CONTRACT_ID })
    const register = (kind: string, list: readonly Entry[]) =>
      list.forEach((entry, index) => {
        this.#index.set(
          `${kind}:${entry.name}:params`,
          `/${kind}/${index}/params/0/schema`,
        )
        if (entry.result)
          this.#index.set(
            `${kind}:${entry.name}:result`,
            `/${kind}/${index}/result/schema`,
          )
      })
    register('methods', subset.methods)
    register('canonicalMethods', subset.canonicalMethods)
    register('serverRequests', subset.serverRequests)
    register('notifications', subset.notifications)
  }

  get provenance() {
    return subset.provenance
  }

  /** Every method, server request and notification name in the subset. */
  has(
    kind: 'methods' | 'canonicalMethods' | 'serverRequests' | 'notifications',
    name: string,
  ) {
    return this.#index.has(`${kind}:${name}:params`)
  }

  methodParams(method: string, params: unknown, canonical = false): ContractCheck {
    return this.#check(
      `${canonical ? 'canonicalMethods' : 'methods'}:${method}:params`,
      params,
    )
  }

  methodResult(method: string, result: unknown, canonical = false): ContractCheck {
    return this.#check(
      `${canonical ? 'canonicalMethods' : 'methods'}:${method}:result`,
      result,
    )
  }

  notification(type: string, payload: unknown): ContractCheck {
    return this.#check(`notifications:${type}:params`, payload)
  }

  serverRequestParams(method: string, params: unknown): ContractCheck {
    return this.#check(`serverRequests:${method}:params`, params)
  }

  serverRequestResult(method: string, result: unknown): ContractCheck {
    return this.#check(`serverRequests:${method}:result`, result)
  }

  #check(key: string, value: unknown): ContractCheck {
    const pointer = this.#index.get(key)
    if (!pointer)
      return {
        ok: false,
        errors: [`${key} is not in the vendored subset`],
        unknownKeysOnly: false,
      }
    let validate = this.#cache.get(key)
    if (!validate) {
      validate = this.#ajv.compile({ $ref: `${CONTRACT_ID}#${pointer}` })
      this.#cache.set(key, validate)
    }
    if (validate(value)) return { ok: true, errors: [], unknownKeysOnly: false }
    const errors = (validate.errors ?? []).map(
      (error) =>
        `${key}${error.instancePath || ''}: ${error.message ?? 'invalid'}${
          error.keyword === 'additionalProperties'
            ? ` (${String((error.params as { additionalProperty?: unknown }).additionalProperty)})`
            : ''
        }`,
    )
    // anyOf branches report extra noise; an unknown key at the top level is the decisive one.
    const unknownKeysOnly =
      (validate.errors ?? []).some(
        (e) => e.keyword === 'additionalProperties' && !e.instancePath,
      ) &&
      (validate.errors ?? []).every(
        (e) =>
          e.keyword === 'additionalProperties' ||
          e.keyword === 'anyOf' ||
          e.keyword === 'type',
      )
    return { ok: false, errors, unknownKeysOnly }
  }
}
