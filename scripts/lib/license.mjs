// Rules for the licence gate (scripts/check-license.mjs).
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { listFiles } from './git.mjs'
import { codeSpans, tables } from './markdown.mjs'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * SHA-256 of LICENSE's exact copyright line, the one README's licence section
 * states. The holder is pinned by digest because the privacy scan allows the
 * name only in LICENSE, THIRD_PARTY_NOTICES.md and README's licence section.
 * Verify with: sed -n 3p LICENSE | tr -d '\n' | sha256sum
 */
export const COPYRIGHT_LINE_SHA256 =
  '791610d88c7f3654fb5f001cc38d4b63fb46efe0ce614b7a5c4507108b6cfdbe'

export const MIT_TEXT = `MIT License

<copyright line>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

/** Each third-party licence: how a notice names it, its SPDX id, text its file contains. */
const LICENCES = [
  { kind: /\bMIT\b/, spdx: 'MIT', text: 'Permission is hereby granted, free of charge' },
  {
    kind: /Open Font License|\bOFL\b/,
    spdx: 'OFL-1.1',
    text: 'SIL OPEN FONT LICENSE Version 1.1',
  },
]

/**
 * A package's "license" field: MIT for Cindl's own code, and an SPDX AND
 * expression when it also ships third-party material under another licence
 * (for example "(MIT AND OFL-1.1)" for the package that bundles the fonts).
 */
export function expectedLicence(spdxIds) {
  const others = [...new Set(spdxIds)].filter((id) => id !== 'MIT').sort()
  return others.length ? `(${['MIT', ...others].join(' AND ')})` : 'MIT'
}

/** Directories that hold third-party material; every file in them needs a notice. */
const VENDORED = /(^|\/)(upstream|vendor|vendored|third[_-]party|fonts)\//

export function checkLicensing(root) {
  const errors = []
  const files = listFiles(root)
  const tracked = new Set(files)
  const read = (path) => readFileSync(join(root, path), 'utf8')
  const isTracked = (path) => {
    const clean = path.replace(/\/$/, '')
    return tracked.has(clean) || files.some((file) => file.startsWith(`${clean}/`))
  }

  // 1. LICENSE: the MIT text with the pinned copyright line, character for character.
  if (!tracked.has('LICENSE')) errors.push('LICENSE is missing')
  else {
    const text = read('LICENSE').replace(/\r\n/g, '\n')
    const line = text.split('\n')[2] ?? ''
    if (text !== MIT_TEXT.replace('<copyright line>', line))
      errors.push(
        'LICENSE is not the standard MIT licence text (compare with MIT_TEXT in scripts/lib/license.mjs)',
      )
    if (sha256(line) !== COPYRIGHT_LINE_SHA256)
      errors.push(
        'LICENSE: the copyright line is not the pinned one (the exact line in the README licence section)',
      )
  }

  // 2. README states the same licence and copyright line in its licence section.
  if (tracked.has('README.md')) {
    const readme = read('README.md')
    const start = readme.search(/^## Licen[cs]e\s*$/m)
    const section = start < 0 ? '' : readme.slice(start).split(/\n## /)[0]
    const stated = /Copyright \(c\) \d{4} [^.\n]+/.exec(section)?.[0]
    if (!/\bMIT\b/.test(section) || !stated || sha256(stated) !== COPYRIGHT_LINE_SHA256)
      errors.push(
        'README.md: the licence section must say MIT and state the pinned copyright line',
      )
  } else errors.push('README.md is missing')

  // 3. THIRD_PARTY_NOTICES.md: each row's material and licence file exist.
  const covered = []
  const material = [] // { location, name, spdx } for the package licence check
  if (!tracked.has('THIRD_PARTY_NOTICES.md'))
    errors.push('THIRD_PARTY_NOTICES.md is missing')
  else {
    const notices = read('THIRD_PARTY_NOTICES.md')
    const table = tables(notices).find((t) => /^material$/i.test(t.header[0] ?? ''))
    if (!table?.rows.length)
      errors.push('THIRD_PARTY_NOTICES.md: no table with a "Material" column')
    for (const [name, location = '', licence = '', source = ''] of table?.rows ?? []) {
      const locations = codeSpans(location)
      if (!locations.length)
        errors.push(`THIRD_PARTY_NOTICES.md: "${name}" names no location`)
      if (!source) errors.push(`THIRD_PARTY_NOTICES.md: "${name}" has no source`)
      const spdx = LICENCES.filter((entry) => entry.kind.test(licence)).map((e) => e.spdx)
      if (!spdx.length)
        errors.push(
          `THIRD_PARTY_NOTICES.md: "${name}" names a licence scripts/lib/license.mjs does not know (add it to LICENCES)`,
        )
      for (const path of locations) {
        if (!isTracked(path))
          errors.push(
            `THIRD_PARTY_NOTICES.md: "${name}" location ${path} is not in the repository`,
          )
        covered.push(path.replace(/\/$/, ''))
        material.push({ location: path.replace(/\/$/, ''), name, spdx })
      }
      const licenceFiles = codeSpans(licence)
      if (!licenceFiles.length)
        errors.push(`THIRD_PARTY_NOTICES.md: "${name}" names no licence file`)
      for (const file of licenceFiles) {
        const candidates = [
          file,
          ...locations.map((path) =>
            posix.join(path.endsWith('/') ? path : posix.dirname(path), file),
          ),
        ]
        const found = candidates.find((candidate) => tracked.has(candidate))
        if (!found) {
          errors.push(`THIRD_PARTY_NOTICES.md: "${name}" licence file ${file} is missing`)
          continue
        }
        covered.push(found)
        for (const entry of LICENCES)
          if (entry.kind.test(licence) && !read(found).includes(entry.text))
            errors.push(
              `${found}: does not contain the ${entry.spdx} licence text its notice names`,
            )
      }
    }
    // Paths the notices mention elsewhere (for example a checksum list) are acknowledged too.
    covered.push(...codeSpans(notices).filter((span) => tracked.has(span)))
  }

  // 4. Every first-party package is private (nothing is published to npm) and
  // declares MIT, plus the licences of third-party material it ships.
  const manifests = files.filter((file) => posix.basename(file) === 'package.json')
  const packageDirs = manifests.map((file) => posix.dirname(file))
  const ownerOf = (path) =>
    packageDirs
      .filter((dir) => dir === '.' || path === dir || path.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0]
  for (const path of manifests) {
    let manifest
    try {
      manifest = JSON.parse(read(path))
    } catch {
      errors.push(`${path}: not valid JSON`)
      continue
    }
    const dir = posix.dirname(path)
    const shipped = material.filter((entry) => ownerOf(entry.location) === dir)
    const expected = expectedLicence(['MIT', ...shipped.flatMap((entry) => entry.spdx)])
    if (manifest.license !== expected)
      errors.push(
        `${path}: "license" must be "${expected}"${shipped.length ? ` because it ships ${[...new Set(shipped.map((entry) => entry.name))].join(', ')} (THIRD_PARTY_NOTICES.md)` : ''}`,
      )
    if (manifest.private !== true) errors.push(`${path}: "private" must be true`)
  }

  // 5. Every file in a third-party directory is covered by a notice.
  for (const file of files.filter((path) => VENDORED.test(path)))
    if (!covered.some((path) => file === path || file.startsWith(`${path}/`)))
      errors.push(`${file}: third-party material without a THIRD_PARTY_NOTICES.md entry`)

  // 6. Checksum lists match the files they cover, and cover every file beside them.
  for (const list of files.filter((path) => posix.basename(path) === 'SHA256SUMS')) {
    const dir = posix.dirname(list)
    const listed = new Set()
    for (const entry of read(list).split('\n').filter(Boolean)) {
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(entry)
      if (!match) {
        errors.push(`${list}: malformed line "${entry}"`)
        continue
      }
      const path = posix.join(dir, match[2])
      listed.add(path)
      if (!tracked.has(path) || !statSync(join(root, path)).isFile())
        errors.push(`${list}: lists ${match[2]}, which is not in the repository`)
      else if (sha256(readFileSync(join(root, path))) !== match[1])
        errors.push(`${list}: checksum mismatch for ${match[2]}`)
    }
    for (const file of files.filter(
      (path) => path.startsWith(`${dir}/`) && path !== list,
    ))
      if (!listed.has(file))
        errors.push(`${list}: does not list ${file.slice(dir.length + 1)}`)
  }

  return {
    errors,
    summary: `LICENSE is MIT with the pinned copyright line; ${manifests.length} package manifests are private with the expected licence; every third-party file has a notice, an existing licence file and a matching checksum.`,
  }
}
