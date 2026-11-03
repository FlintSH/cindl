import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Owner read/write only: files in userData can hold private (if non-secret) data. */
export const PRIVATE_FILE_MODE = 0o600

/**
 * Replaces `file` atomically: write a sibling temp file, flush it, rename it
 * over the target. A crash leaves either the old or the new content, never a
 * truncated mix.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(temp, 'wx', PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
}

/** Reads a JSON file; a missing file is `undefined`, a corrupt one throws. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text) as unknown
}

/** Runs async tasks one at a time, in order (file writes must not interleave). */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}
