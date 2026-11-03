import type { KeyValueStore } from '@cindl/client-core'
import { createSerialQueue, readJsonFile, writeFileAtomic } from './files.ts'

// The direct client's keys embed the Hermes origin (up to 2048 characters),
// and its prompt outbox can hold several long prompts.
const MAX_KEY_LENGTH = 4096
const MAX_VALUE_LENGTH = 8_000_000

function checkKey(key: string) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH)
    throw new TypeError('Invalid key-value store key')
}

/**
 * Non-secret settings in one JSON file in userData (Hermes origin, device
 * preferences, the client's outbox and answered-request ledger). Secrets go
 * to the secret store, never here.
 */
export function createFileKeyValueStore(
  file: string,
  onWarning?: (message: string, detail?: unknown) => void,
): KeyValueStore {
  const queue = createSerialQueue()
  let cache: Map<string, string> | undefined

  const load = async () => {
    if (!cache) {
      cache = new Map()
      try {
        const data = await readJsonFile(file)
        if (typeof data === 'object' && data !== null && !Array.isArray(data))
          for (const [key, value] of Object.entries(data))
            if (typeof value === 'string') cache.set(key, value)
      } catch (error) {
        onWarning?.('Ignoring an unreadable settings file', error)
      }
    }
    return cache
  }
  const save = (data: Map<string, string>) =>
    writeFileAtomic(file, `${JSON.stringify(Object.fromEntries(data), null, 2)}\n`)

  return {
    get: (key) =>
      queue(async () => {
        checkKey(key)
        return (await load()).get(key)
      }),
    set: (key, value) =>
      queue(async () => {
        checkKey(key)
        if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH)
          throw new TypeError('Invalid key-value store value')
        const data = await load()
        data.set(key, value)
        await save(data)
      }),
    delete: (key) =>
      queue(async () => {
        checkKey(key)
        const data = await load()
        if (data.delete(key)) await save(data)
      }),
  }
}
