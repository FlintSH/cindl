import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** One `sha256sum` line for `file`, so `sha256sum -c <file>.sha256` checks it. */
export function checksumLine(file: string): string {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  return `${hash}  ${path.basename(file)}\n`
}

/** Writes `<file>.sha256` next to `file`; returns its path. */
export function writeChecksum(file: string): string {
  const target = `${file}.sha256`
  writeFileSync(target, checksumLine(file))
  return target
}
