import { execFileSync } from 'node:child_process'

const git = (repo, args) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

/**
 * Where this build came from, read from Git when the site is built. There is
 * deliberately no hardcoded version or branch. Without Git metadata (a source
 * archive) the commit comes from CI's GITHUB_SHA if present and the working
 * tree state is unknown (`dirty: null`), which the page says plainly.
 */
export function getBuildInfo(repo) {
  const builtAt = new Date().toISOString()
  try {
    const commit = git(repo, ['rev-parse', 'HEAD'])
    const dirty = git(repo, ['status', '--porcelain', '--untracked-files=normal']) !== ''
    return { commit, shortCommit: commit.slice(0, 12), dirty, builtAt, source: 'git' }
  } catch {
    const sha = process.env.GITHUB_SHA ?? ''
    const commit = /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null
    return {
      commit,
      shortCommit: commit ? commit.slice(0, 12) : null,
      dirty: null,
      builtAt,
      source: commit ? 'GITHUB_SHA' : 'unavailable',
    }
  }
}
