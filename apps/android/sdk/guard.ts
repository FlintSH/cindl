import { createHash } from 'node:crypto'
import {
  APPROVED_LICENCE,
  REPOSITORIES,
  type PinnedPackage,
  type RepositoryName,
} from './android-sdk.ts'

/**
 * Pure checks behind scripts/android-sdk.ts: Google's repository manifests and
 * installed package metadata must map every pinned package to the approved
 * licence text at the pinned revision. Google's XML is regular enough for the
 * small extractor below; anything it cannot read counts as missing.
 */

/** The licence the checks require: its sdkmanager id and the SHA-1 of its trimmed text. */
export interface Licence {
  id: string
  textSha1: string
}

export interface Finding {
  level: 'error' | 'notice'
  message: string
}

export interface RemoteArchive {
  hostOs?: string
  url: string
  sha1: string
  size: number
}

export interface RemotePackage {
  path: string
  revision: string
  licence?: string
  channel: string
  archives: RemoteArchive[]
}

export interface ParsedManifest {
  licences: Map<string, string>
  packages: RemotePackage[]
}

export function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, raw: string) => raw)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

const attribute = (attrs: string, name: string) =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]

const element = (body: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]

/** major[.minor[.micro]] with a "-rcN" suffix for previews, as in source.properties. */
function parseRevision(body: string): string {
  const revision = element(body, 'revision') ?? ''
  const parts = ['major', 'minor', 'micro']
    .map((name) => element(revision, name)?.trim())
    .filter((part): part is string => part !== undefined)
  const preview = element(revision, 'preview')?.trim()
  return parts.join('.') + (preview ? `-rc${preview}` : '')
}

function parseLicences(xml: string): Map<string, string> {
  const licences = new Map<string, string>()
  for (const match of xml.matchAll(/<license\s([^>]*)>([\s\S]*?)<\/license>/g)) {
    const id = attribute(match[1] ?? '', 'id')
    if (id) licences.set(id, decodeXml(match[2] ?? ''))
  }
  return licences
}

export function parseManifest(xml: string): ParsedManifest {
  const packages: RemotePackage[] = []
  for (const match of xml.matchAll(
    /<remotePackage\s([^>]*)>([\s\S]*?)<\/remotePackage>/g,
  )) {
    const attrs = match[1] ?? ''
    const body = match[2] ?? ''
    const path = attribute(attrs, 'path')
    if (!path) continue
    const archives: RemoteArchive[] = []
    for (const archive of body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const inner = archive[1] ?? ''
      const complete = element(inner, 'complete') ?? ''
      const url = element(complete, 'url')?.trim()
      const sha1 = /<checksum[^>]*>([0-9a-fA-F]{40})<\/checksum>/.exec(complete)?.[1]
      const size = Number(element(complete, 'size')?.trim())
      if (!url || !sha1 || !Number.isFinite(size)) continue
      const hostOs = element(inner, 'host-os')?.trim()
      archives.push({
        ...(hostOs ? { hostOs } : {}),
        url,
        sha1: sha1.toLowerCase(),
        size,
      })
    }
    const licence = /<uses-license\s+ref="([^"]+)"/.exec(body)?.[1]
    packages.push({
      path,
      revision: parseRevision(body),
      ...(licence ? { licence } : {}),
      channel: /<channelRef\s+ref="([^"]+)"/.exec(body)?.[1] ?? 'channel-0',
      archives,
    })
  }
  return { licences: parseLicences(xml), packages }
}

/**
 * A licence is identified by its words: the XML-decoded text with Unicode
 * composed (NFC) and every run of whitespace, line breaks included, collapsed
 * to one space. Formatting differences between Google's manifest and the
 * package.xml sdkmanager wrote on the runner therefore match; any change in
 * wording, punctuation or characters does not.
 */
export function normalizeLicenceText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** The hash this project pins for a licence: SHA-1 of its normalized text. */
export function licenceTextSha1(text: string): string {
  return createHash('sha1').update(normalizeLicenceText(text), 'utf8').digest('hex')
}

const rawSha1 = (text: string) => createHash('sha1').update(text, 'utf8').digest('hex')

/** How a licence text is represented, for logs and evidence. */
export function describeLicenceText(text: string): string {
  return `${text.length} chars, raw sha1 ${rawSha1(text)}, words sha1 ${licenceTextSha1(text)}`
}

/**
 * The exact formatting difference between two texts with the same words, as
 * line hunks ("manifest lines → installed lines", JSON-escaped), for logs
 * and regression tests. Licence texts are public, so they can be shown.
 */
export function formattingDelta(
  installed: string,
  approved: string,
  maxHunks = 12,
): string {
  if (installed === approved) return 'identical'
  const a = approved.split('\n')
  const b = installed.split('\n')
  // Longest common subsequence of lines (licence texts have a few hundred lines).
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (lcs[i + 1] as number[])[j] as number,
              (lcs[i] as number[])[j + 1] as number,
            )
  const hunks: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
      continue
    }
    const startA = i
    const startB = j
    while (
      (i < a.length || j < b.length) &&
      !(i < a.length && j < b.length && a[i] === b[j])
    ) {
      const down = i < a.length ? ((lcs[i + 1] as number[])[j] as number) : -1
      const right = j < b.length ? ((lcs[i] as number[])[j + 1] as number) : -1
      if (down >= right) i++
      else j++
    }
    const excerpt = (lines: string[]) => {
      const text = lines.join('\n')
      return JSON.stringify(
        text.length > 80 ? `${text.slice(0, 38)}…${text.slice(-38)}` : text,
      )
    }
    const range = (start: number, end: number) =>
      end === start
        ? `none (after line ${start})`
        : end === start + 1
          ? `line ${end}`
          : `lines ${start + 1}-${end}`
    hunks.push(
      `manifest ${range(startA, i)} ${excerpt(a.slice(startA, i))} → installed ${range(startB, j)} ${excerpt(b.slice(startB, j))}`,
    )
  }
  const shown = hunks.slice(0, maxHunks).join('; ')
  return hunks.length > maxHunks ? `${shown}; and ${hunks.length - maxHunks} more` : shown
}

/** Where two licence texts first differ in their words, with context from both. */
export function licenceDifference(installed: string, approved: string): string {
  const a = normalizeLicenceText(installed)
  const b = normalizeLicenceText(approved)
  if (a === b) return 'same words (formatting differs only)'
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  const context = (text: string) =>
    JSON.stringify(text.slice(Math.max(0, at - 60), at + 60))
  return `words differ at character ${at} of ${a.length} (approved ${b.length}): installed ${context(a)}; approved ${context(b)}`
}

const approvedText = (
  licences: Map<string, string>,
  where: string,
  licence: Licence,
): Finding[] => {
  const text = licences.get(licence.id)
  if (text === undefined)
    return [{ level: 'error', message: `${where} does not contain ${licence.id}.` }]
  const sha1 = licenceTextSha1(text)
  return sha1 === licence.textSha1
    ? []
    : [
        {
          level: 'error',
          message:
            `The ${licence.id} text in ${where} is not the approved one ` +
            `(sha1 ${sha1}, approved ${licence.textSha1}). Stop: the owner must review the new terms.`,
        },
      ]
}

const archiveName = (url: string) => url.slice(url.lastIndexOf('/') + 1)

/** Google's manifests must still offer every pinned package under the approved licence. */
export function checkManifests(
  manifests: Partial<Record<RepositoryName, ParsedManifest>>,
  packages: readonly PinnedPackage[],
  licence: Licence = APPROVED_LICENCE,
): Finding[] {
  const findings: Finding[] = []
  const used = new Set(packages.map((pin) => pin.repository))
  for (const name of used) {
    const manifest = manifests[name]
    if (!manifest) {
      findings.push({
        level: 'error',
        message: `No manifest read from ${REPOSITORIES[name]}.`,
      })
      continue
    }
    findings.push(...approvedText(manifest.licences, REPOSITORIES[name], licence))
  }
  for (const pin of packages) {
    const manifest = manifests[pin.repository]
    if (!manifest) continue
    const stable = manifest.packages.filter(
      (entry) => entry.path === pin.id && entry.channel === 'channel-0',
    )
    if (stable.length === 0) {
      findings.push({
        level: 'error',
        message: `${pin.id} is no longer in Google's stable channel (${REPOSITORIES[pin.repository]}); review before use.`,
      })
      continue
    }
    for (const entry of stable) {
      if (entry.licence !== licence.id)
        findings.push({
          level: 'error',
          message: `${pin.id} uses ${entry.licence ?? 'no licence'}, not ${licence.id}. Stop: not approved.`,
        })
      if (entry.revision !== pin.revision) {
        findings.push({
          level: 'notice',
          message: `${pin.id}: Google now lists revision ${entry.revision}; CI keeps the pinned ${pin.revision}.`,
        })
      } else if (pin.archive) {
        const match = entry.archives.find(
          (archive) => archiveName(archive.url) === archiveName(pin.archive?.url ?? ''),
        )
        if (!match || match.sha1 !== pin.archive.sha1 || match.size !== pin.archive.size)
          findings.push({
            level: 'error',
            message: `${pin.id} ${pin.revision}: the pinned archive does not match Google's manifest.`,
          })
      }
    }
  }
  return findings
}

export interface LocalPackage {
  path: string
  revision: string
  licence?: string
  licenceText?: string
}

/** An installed package.xml (written by sdkmanager when the runner image was built). */
export function parsePackageXml(xml: string): LocalPackage | undefined {
  const match = /<localPackage\s([^>]*)>([\s\S]*?)<\/localPackage>/.exec(xml)
  const path = match ? attribute(match[1] ?? '', 'path') : undefined
  if (!match || !path) return undefined
  const body = match[2] ?? ''
  const licence = /<uses-license\s+ref="([^"]+)"/.exec(body)?.[1]
  const licenceText = licence ? parseLicences(xml).get(licence) : undefined
  return {
    path,
    revision: parseRevision(body),
    ...(licence ? { licence } : {}),
    ...(licenceText !== undefined ? { licenceText } : {}),
  }
}

/** What CI writes next to a package it downloaded (no package.xml without sdkmanager). */
export interface InstallMarker {
  id: string
  revision: string
  licence: string
  licenceTextSha1: string
  archive: { url: string; sha1: string; size: number; sha256: string }
}

export const MARKER_FILE = 'cindl-package.json'

export interface InstalledPackage {
  id: string
  revision: string
  licence: string
  source: 'preinstalled' | 'downloaded'
  /** For preinstalled packages: how their package.xml represents the licence text. */
  licenceText?: string
  sha256?: string
}

/**
 * Every pinned package must be installed at its revision under the approved
 * licence. `read` returns a file's text or undefined when it does not exist.
 */
export function checkInstalled(
  read: (relativePath: string) => string | undefined,
  packages: readonly PinnedPackage[],
  licence: Licence = APPROVED_LICENCE,
): {
  findings: Finding[]
  installed: InstalledPackage[]
  /** Licence texts found in package.xml files that are not the approved one, by words sha1. */
  otherTexts: Record<string, string>
  /** Every licence text found in package.xml files that matched, by raw sha1. */
  matchedTexts: Record<string, string>
} {
  const findings: Finding[] = []
  const installed: InstalledPackage[] = []
  const otherTexts: Record<string, string> = {}
  const matchedTexts: Record<string, string> = {}
  const missing = (pin: PinnedPackage, why: string) =>
    findings.push({
      level: 'error',
      message: `${pin.id} revision ${pin.revision} (licence ${licence.id}) ${why}`,
    })
  for (const pin of packages) {
    const xml = read(`${pin.path}/package.xml`)
    const marker = read(`${pin.path}/${MARKER_FILE}`)
    if (xml !== undefined) {
      const local = parsePackageXml(xml)
      if (!local || local.path !== pin.id) {
        missing(pin, `is not installed (unreadable ${pin.path}/package.xml).`)
      } else if (local.revision !== pin.revision) {
        missing(pin, `is not installed: found revision ${local.revision}.`)
      } else if (local.licence !== licence.id) {
        missing(
          pin,
          `is installed under ${local.licence ?? 'no licence'}. Stop: not approved.`,
        )
      } else if (local.licenceText === undefined) {
        missing(
          pin,
          `has no ${licence.id} text in its package.xml. Stop: review the package.`,
        )
      } else if (licenceTextSha1(local.licenceText) !== licence.textSha1) {
        const sha1 = licenceTextSha1(local.licenceText)
        otherTexts[sha1] = local.licenceText
        missing(
          pin,
          `is installed with a different licence text (${describeLicenceText(local.licenceText)}; ` +
            `approved words sha1 ${licence.textSha1}). Stop: review the terms.`,
        )
      } else {
        installed.push({
          id: pin.id,
          revision: pin.revision,
          licence: local.licence,
          source: 'preinstalled',
          licenceText: describeLicenceText(local.licenceText),
        })
        matchedTexts[rawSha1(local.licenceText)] = local.licenceText
      }
      continue
    }
    if (marker !== undefined) {
      let parsed: Partial<InstallMarker> | undefined
      try {
        parsed = JSON.parse(marker) as Partial<InstallMarker>
      } catch {
        parsed = undefined
      }
      if (
        parsed?.id === pin.id &&
        parsed.revision === pin.revision &&
        parsed.licence === licence.id &&
        parsed.licenceTextSha1 === licence.textSha1 &&
        parsed.archive?.sha1 === pin.archive?.sha1
      ) {
        installed.push({
          id: pin.id,
          revision: pin.revision,
          licence: parsed.licence,
          source: 'downloaded',
          ...(parsed.archive?.sha256 ? { sha256: parsed.archive.sha256 } : {}),
        })
      } else {
        missing(pin, `is not installed (stale ${pin.path}/${MARKER_FILE}).`)
      }
      continue
    }
    missing(pin, 'is not installed.')
  }
  return { findings, installed, otherTexts, matchedTexts }
}

/** Pkg.Revision from a source.properties file. */
export function sourceRevision(properties: string): string | undefined {
  return /^Pkg\.Revision=(.+)$/m.exec(properties)?.[1]?.trim()
}

export const errors = (findings: readonly Finding[]) =>
  findings.filter((finding) => finding.level === 'error')
