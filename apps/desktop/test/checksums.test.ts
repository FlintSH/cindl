import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeChecksum } from '../scripts/checksums.ts'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

it('writes the checksum file the handbook tells owners to check with sha256sum -c', () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cindl-checksum-'))
  const file = path.join(dir, 'Cindl-Setup-1.0.0.exe')
  writeFileSync(file, 'synthetic installer bytes')
  const written = writeChecksum(file)
  expect(written).toBe(`${file}.sha256`)
  const hash = createHash('sha256').update('synthetic installer bytes').digest('hex')
  expect(readFileSync(written, 'utf8')).toBe(`${hash}  Cindl-Setup-1.0.0.exe\n`)
  if (process.platform === 'win32') return
  const check = () =>
    execFileSync('sha256sum', ['-c', 'Cindl-Setup-1.0.0.exe.sha256'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
  expect(check()).toBe('Cindl-Setup-1.0.0.exe: OK\n')
  // A damaged download fails the check.
  writeFileSync(file, 'synthetic installer bytez')
  expect(check).toThrow()
})
