#!/usr/bin/env node
// Privacy and secret scan over every tracked file: credential formats, private
// network addresses and hostnames, personal email addresses, the copyright
// holder's name outside the licence files, generated output, credential-bearing
// file types and unexpected binaries or large files. Rules and allowlists live
// in scripts/lib/privacy.mjs. Findings are masked so the log does not repeat them.
//
// Usage: node scripts/check-privacy.mjs [--root <repository>] [--include-untracked]
//          [--markers <file>]   (or CINDL_PRIVACY_MARKERS=<file>)
// A markers file lists extra private strings (your hostnames, names, addresses),
// one per line. Keep it outside the repository; it is never committed.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRoot, report } from './lib/git.mjs'
import { readMarkers, scanRepository } from './lib/privacy.mjs'

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    'include-untracked': { type: 'boolean' },
    markers: { type: 'string' },
  },
})
try {
  const markersFile = values.markers ?? process.env.CINDL_PRIVACY_MARKERS
  const markers = readMarkers(markersFile)
  const { problems, files, scanned } = scanRepository(
    resolve(values.root ?? defaultRoot),
    {
      untracked: values['include-untracked'] === true,
      markers,
    },
  )
  report(
    'privacy scan',
    problems,
    `${files} files checked (${scanned} text files scanned${markers.length ? `, ${markers.length} private markers` : ''}); no secrets, private addresses or personal data found.`,
  )
} catch (error) {
  report('privacy scan', [error.message], '')
}
