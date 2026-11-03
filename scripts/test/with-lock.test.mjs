import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { repoRoot, tempDir } from './helpers.mjs'

const lock = (t, args) =>
  spawnSync(join(repoRoot, 'scripts/with-lock.sh'), args, {
    encoding: 'utf8',
    env: { ...process.env, CINDL_HEAVY_LOCK: join(tempDir(t), 'heavy.lock') },
  })

describe('with-lock.sh', () => {
  it('runs the command and passes its exit code through', (t) => {
    const result = lock(t, [
      process.execPath,
      '-e',
      'console.log("ran"); process.exit(3)',
    ])
    assert.equal(result.status, 3)
    assert.match(result.stdout, /ran/)
  })

  it('refuses to run without a command', (t) => {
    const result = lock(t, [])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage: scripts\/with-lock\.sh/)
  })
})
