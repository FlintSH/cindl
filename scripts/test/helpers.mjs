// Fixture helpers for the gate tests: throwaway Git repositories and folders
// in the system temporary directory, and a runner that executes a gate as its
// own process exactly as CI does.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const repoRoot = join(import.meta.dirname, '../..')

// Isolate Git from the developer's configuration (signing, hooks, identity).
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
}
delete ENV.CINDL_PRIVACY_MARKERS
delete ENV.DOCS_BASE

/** Join parts at runtime so no secret-shaped literal exists in this repository. */
export const fake = (...parts) => parts.join('')

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cindl-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    if (content === null) {
      rmSync(target, { force: true, recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

export function git(dir, args, env = {}) {
  return execFileSync('git', args, {
    cwd: dir,
    env: { ...ENV, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** A new repository with `files` staged (tracked) but not committed. */
export function makeRepo(t, files = {}) {
  const dir = tempDir(t)
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  writeFiles(dir, files)
  git(dir, ['add', '--all'])
  return dir
}

/** Write (or with null, delete) files, commit them all, return the new SHA. */
export function commit(dir, files, message, env = {}) {
  writeFiles(dir, files)
  git(dir, ['add', '--all'])
  git(dir, ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', message], env)
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** Run scripts/<name> with node; returns exit code and combined output. */
export function run(name, args = [], { cwd = repoRoot, env = {} } = {}) {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', name), ...args], {
    cwd,
    env: { ...ENV, ...env },
    encoding: 'utf8',
  })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

export const readRepoFile = (path) => readFileSync(join(repoRoot, path), 'utf8')
