// Small, dependency-free helpers shared by the repository gates in scripts/.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file so gates work from any directory. */
export const defaultRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Run git and return stdout. Throws (with git's stderr) when git fails. */
export function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (allowFailure) return null
    const detail = String(error.stderr || error.message).trim()
    throw new Error(`git ${args.join(' ')} failed: ${detail}`, { cause: error })
  }
}

export const lines = (text) => text.split('\n').filter(Boolean)
export const nulSeparated = (text) => text.split('\0').filter(Boolean)

/** Tracked paths (and optionally untracked, non-ignored ones), repo-relative. */
export function listFiles(root, { untracked = false } = {}) {
  const tracked = nulSeparated(git(root, ['ls-files', '-z']))
  if (!untracked) return tracked
  const others = nulSeparated(
    git(root, ['ls-files', '-z', '--others', '--exclude-standard']),
  )
  return [...new Set([...tracked, ...others])].sort()
}

/** Print a gate failure in one consistent shape and set a failing exit code. */
export function report(name, errors, success) {
  if (errors.length) {
    console.error(`${name}: ${errors.length} problem(s)\n`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return false
  }
  console.log(`${name}: ${success}`)
  return true
}
