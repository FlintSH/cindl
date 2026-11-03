// Rules for the privacy and secret scan (scripts/check-privacy.mjs). This
// repository is public: it holds source and synthetic examples only. Every
// rule here is deliberately narrow and explained; extending an allowlist is a
// reviewed change to this file, never an inline exemption.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isIPv6 } from 'node:net'
import { join } from 'node:path'
import { listFiles } from './git.mjs'

const KiB = 1024
const MiB = 1024 * KiB

/** Largest tracked file allowed outside the allowlist below. */
export const DEFAULT_MAX_BYTES = 256 * KiB

/** Paths that may hold binary or larger files, each with its own size limit. */
export const ALLOWED_FILES = [
  {
    path: /^packages\/tokens\/fonts\/[^/]+\/[^/]+\.(woff2?|ttf|otf)$/,
    binary: true,
    max: 512 * KiB,
    why: 'bundled SIL OFL fonts (THIRD_PARTY_NOTICES.md)',
  },
  {
    path: /^packages\/hermes-adapter\/upstream\/v[^/]+\/contract-subset\.json$/,
    binary: false,
    max: 1 * MiB,
    why: 'vendored Hermes contract subset (THIRD_PARTY_NOTICES.md)',
  },
  { path: /(^|\/)pnpm-lock\.yaml$/, binary: false, max: 4 * MiB, why: 'lockfiles' },
  {
    path: /^docs\/handbook\/public\/screenshots\/[^/]+\.(png|webp|jpe?g)$/,
    binary: true,
    max: 1 * MiB,
    why: 'reviewed screenshots of synthetic data',
  },
  {
    path: /^docs\/handbook\/public\/media\/[^/]+\.(webm|mp4|png|webp)$/,
    binary: true,
    max: 8 * MiB,
    why: 'reviewed recordings of synthetic data',
  },
  {
    path: /^apps\/[^/]+\/(public|assets|resources)\/.+\.(png|webp|jpe?g|gif|ico|icns)$/,
    binary: true,
    max: 1 * MiB,
    why: 'app icons and images',
  },
]

/** Build output, caches and local state that must never be committed. */
export const GENERATED_PATHS = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist|dist-[^/]+|build|out|release|coverage)\//,
  /(^|\/)\.vitepress\/(dist|cache)\//,
  /(^|\/)(\.turbo|\.vite|\.expo|\.gradle|\.cache|test-results|playwright-report|blob-report)\//,
  /^apps\/android\/(android|ios)\//,
  /(^|\/)\.agent-artifacts\//,
  /\.(tsbuildinfo|log|map)$/,
  /(^|\/)(\.DS_Store|Thumbs\.db)$/,
  /\.(apk|aab|AppImage|dmg|exe|msi|deb|rpm|snap|ipa)$/,
]

/** File names that hold credentials, sessions or runtime data by convention. */
export const SECRET_FILES = [
  /(^|\/)\.env(\.(?!example$)[^/]+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|mobileprovision|provisionprofile|har)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(auth|credentials[^/]*|cookies[^/]*|storage-state[^/]*|google-services)\.json$/,
  /(^|\/)GoogleService-Info\.plist$/,
  /\.(sqlite3?|db)$/,
  /(^|\/)\.hermes\//,
  /(^|\/)(keystore|signing)\.properties$/,
]

/**
 * Credential formats. Thresholds follow the product's own redactor
 * (packages/hermes-adapter/src/redact.ts): anything Cindl would redact from a
 * log must not appear literally in the repository. Tests assemble synthetic
 * secrets at runtime instead (see packages/hermes-adapter/test/redact.test.ts).
 */
export const SECRET_PATTERNS = [
  ['PEM private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['AWS secret access key', /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/gi],
  ['OpenAI or Anthropic API key', /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{20,}/g],
  ['Stripe live key', /\b[rs]k_live_[A-Za-z0-9]{16,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
]

// Documentation and test-only names (RFC 2606, RFC 6761).
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i
const FILE_EXTENSION_TLD =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|cjs|ts|tsx|json|md|html|woff2?|ttf)$/i
const ALLOWED_EMAILS = new Set(['git@github.com', 'noreply@github.com'])
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|css|scss|sh)$/

// The Android emulator's fixed virtual network: host loopback alias, DNS and
// the emulator itself. The same on every emulator; they identify no network.
const ANDROID_EMULATOR = new Set(['10.0.2.2', '10.0.2.3', '10.0.2.15'])

/**
 * IPv4 addresses that identify nothing: loopback, unspecified, broadcast,
 * RFC 5737 documentation ranges and the Android emulator's fixed addresses.
 */
export function allowedIPv4(address) {
  const [a, b, c] = address.split('.').map(Number)
  return (
    a === 127 ||
    ANDROID_EMULATOR.has(address) ||
    address === '0.0.0.0' ||
    address === '255.255.255.255' ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
}

/** IPv6 addresses that identify nothing: loopback, unspecified, RFC 3849. */
export function allowedIPv6(address) {
  const lower = address.toLowerCase()
  return lower === '::1' || lower === '::' || /^2001:0?db8:/.test(lower)
}

const mask = (value) =>
  value.length <= 6 ? `${value[0]}…` : `${value.slice(0, 4)}…(${value.length} chars)`

/** Line number (1-based) of a character offset. */
const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** The copyright holder named in LICENSE, or null. */
export function copyrightHolder(root) {
  const path = join(root, 'LICENSE')
  if (!existsSync(path)) return null
  const match = /^Copyright \(c\) \d{4}(?:-\d{4})? (.+?)\s*$/m.exec(
    readFileSync(path, 'utf8'),
  )
  return match ? match[1] : null
}

/** Byte range of README's licence section, where the holder may be named. */
function licenceSection(text) {
  const start = text.search(/^## Licen[cs]e\s*$/m)
  if (start < 0) return [0, 0]
  const next = text.slice(start + 3).search(/^## /m)
  return [start, next < 0 ? text.length : start + 3 + next]
}

function* contentFindings(path, text, { holder, markers }) {
  for (const [rule, pattern] of SECRET_PATTERNS)
    for (const match of text.matchAll(pattern))
      yield { rule, line: lineOf(text, match.index), value: match[0] }

  for (const match of text.matchAll(/(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})(?!\w|\.\d)/g)) {
    const address = match[1]
    if (
      address.split('.').every((octet) => Number(octet) <= 255) &&
      !allowedIPv4(address)
    )
      yield {
        rule: 'IPv4 address (use 127.0.0.1 or RFC 5737 192.0.2.x)',
        line: lineOf(text, match.index),
        value: address,
      }
  }
  for (const match of text.matchAll(/(?<![\w:.])[0-9a-f:]{3,39}(?![\w:])/gi)) {
    const address = match[0]
    const groups = address.split(':').filter(Boolean).length
    if (groups >= 3 && isIPv6(address) && !allowedIPv6(address))
      yield {
        rule: 'IPv6 address (use ::1 or RFC 3849 2001:db8::)',
        line: lineOf(text, match.index),
        value: address,
      }
  }

  const emails =
    /(?<![\w.%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w-])/g
  for (const match of text.matchAll(emails)) {
    const [address, domain] = match
    if (EXAMPLE_DOMAIN.test(domain) || FILE_EXTENSION_TLD.test(domain)) continue
    if (
      ALLOWED_EMAILS.has(address.toLowerCase()) ||
      /users\.noreply\.github\.com$/i.test(domain)
    )
      continue
    yield {
      rule: 'email address (use an example.test address)',
      line: lineOf(text, match.index),
      value: address,
    }
  }

  const hosts =
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(ts\.net|localdomain|local|lan|internal|home\.arpa|home|corp|intranet|private)\b(?![.-]?\w)/gi
  for (const match of text.matchAll(hosts)) {
    const before = text.slice(Math.max(0, match.index - 3), match.index)
    const after = text.slice(
      match.index + match[0].length,
      match.index + match[0].length + 2,
    )
    const hostContext =
      before.endsWith('://') || before.endsWith('@') || /^:\d/.test(after)
    if (match[1].toLowerCase() === 'ts.net' || !CODE_FILE.test(path) || hostContext)
      yield {
        rule: `private hostname (.${match[1]})`,
        line: lineOf(text, match.index),
        value: match[0],
      }
  }

  const credentials =
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@([^\s/:?#'"`)<>]+)/gi
  for (const match of text.matchAll(credentials)) {
    const host = match[1]
    if (!LOOPBACK_HOST.test(host) && !EXAMPLE_DOMAIN.test(host))
      yield {
        rule: 'credentials in a URL',
        line: lineOf(text, match.index),
        value: match[0],
      }
  }

  if (holder && path !== 'LICENSE' && path !== 'THIRD_PARTY_NOTICES.md') {
    const parts = holder.split(/\s+/)
    const surname = parts.at(-1)
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const names = [new RegExp(parts.map(escape).join('\\s+'), 'gi')]
    if (parts.length > 1 && surname.length >= 4)
      names.push(new RegExp(`\\b${escape(surname)}\\b`, 'g'))
    const [from, to] = path === 'README.md' ? licenceSection(text) : [0, 0]
    const reported = []
    for (const pattern of names)
      for (const match of text.matchAll(pattern)) {
        const end = match.index + match[0].length
        if (match.index >= from && match.index < to) continue
        if (reported.some(([start, stop]) => match.index < stop && end > start)) continue
        reported.push([match.index, end])
        yield {
          rule: 'names the copyright holder (allowed only in LICENSE, THIRD_PARTY_NOTICES.md and the README licence section)',
          line: lineOf(text, match.index),
          value: match[0],
        }
      }
  }

  for (const [index, marker] of markers.entries()) {
    const lower = text.toLowerCase()
    for (let at = lower.indexOf(marker); at >= 0; at = lower.indexOf(marker, at + 1))
      yield {
        rule: `private marker #${index + 1} from the markers file`,
        line: lineOf(text, at),
        value: '',
      }
  }
}

/** Read extra private markers (one per line, # comments) from a local file. */
export function readMarkers(file) {
  if (!file) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.toLowerCase())
}

/** Scan a repository's files; returns findings as `path:line: rule: excerpt`. */
export function scanRepository(root, { untracked = false, markers = [] } = {}) {
  const holder = copyrightHolder(root)
  const problems = []
  if (!holder)
    problems.push(
      'LICENSE: no "Copyright (c) <year> <holder>" line; cannot check identity',
    )
  const files = listFiles(root, { untracked })
  let scanned = 0
  for (const path of files) {
    const absolute = join(root, path)
    if (GENERATED_PATHS.some((pattern) => pattern.test(path)))
      problems.push(`${path}: build output, cache or local state must not be committed`)
    if (SECRET_FILES.some((pattern) => pattern.test(path)))
      problems.push(`${path}: this kind of file holds credentials or runtime data`)
    if (!existsSync(absolute)) continue
    const stats = statSync(absolute)
    if (!stats.isFile()) continue
    const buffer = readFileSync(absolute)
    const binary = buffer.subarray(0, 8000).includes(0)
    const allowed = ALLOWED_FILES.find((entry) => entry.path.test(path))
    const max = allowed?.max ?? DEFAULT_MAX_BYTES
    if (stats.size > max)
      problems.push(
        `${path}: ${(stats.size / KiB).toFixed(0)} KiB exceeds the ${(max / KiB).toFixed(0)} KiB limit${allowed ? ` for ${allowed.why}` : ' (see ALLOWED_FILES in scripts/lib/privacy.mjs)'}`,
      )
    if (binary && !allowed?.binary) {
      problems.push(
        `${path}: binary file outside the allowed asset paths (scripts/lib/privacy.mjs)`,
      )
      continue
    }
    if (binary) continue
    scanned++
    for (const finding of contentFindings(path, buffer.toString('utf8'), {
      holder,
      markers,
    }))
      problems.push(
        `${path}:${finding.line}: ${finding.rule}${finding.value ? `: ${mask(finding.value)}` : ''}`,
      )
  }
  return { problems, files: files.length, scanned }
}
