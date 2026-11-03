/**
 * Pure helpers for scripts/native-notices.ts: which Maven libraries the APK
 * contains (from Gradle's dependency report), which licence their POM
 * declares, which files in their archives are licence or notice files, and
 * the notice text itself.
 */

export interface Coordinate {
  group: string
  module: string
  version: string
}

export const coordinateId = (c: Coordinate) => `${c.group}:${c.module}:${c.version}`

/**
 * Resolved libraries from `gradle :app:dependencies --configuration
 * releaseRuntimeClasspath`. Project modules, dependency constraints "(c)" and
 * unresolved entries "(n)" are not libraries in the APK; "a:b:1 -> 2" means
 * version 2 was resolved.
 */
export function parseDependencyReport(report: string): Coordinate[] {
  const found = new Map<string, Coordinate>()
  for (const raw of report.split('\n')) {
    const line = raw.replace(/^[\s|+\\-]*/, '').trim()
    if (!line || line.startsWith('project ') || /\((c|n)\)$/.test(line)) continue
    const match = /^([\w.-]+):([\w.-]+)(?::(\S+))?(?: -> (\S+))?/.exec(line)
    if (!match) continue
    const [, group = '', module = '', declared, resolved] = match
    const version =
      resolved ?? (declared && !declared.startsWith('{') ? declared : undefined)
    if (!version) continue
    const coordinate = { group, module, version }
    found.set(coordinateId(coordinate), coordinate)
  }
  return [...found.values()].sort((a, b) =>
    coordinateId(a).localeCompare(coordinateId(b)),
  )
}

export interface Pom {
  licences: Array<{ name: string; url?: string }>
  parent?: Coordinate
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(xml)?.[1]

export function parsePom(xml: string): Pom {
  const licences: Pom['licences'] = []
  const block = tag(xml, 'licenses') ?? ''
  for (const match of block.matchAll(/<license>([\s\S]*?)<\/license>/g)) {
    const body = match[1] ?? ''
    const name = tag(body, 'name')?.replace(/\s+/g, ' ')
    const url = tag(body, 'url')
    if (name || url) licences.push({ name: name ?? url ?? '', ...(url ? { url } : {}) })
  }
  const parentXml = tag(xml, 'parent')
  const parent = parentXml
    ? {
        group: tag(parentXml, 'groupId') ?? '',
        module: tag(parentXml, 'artifactId') ?? '',
        version: tag(parentXml, 'version') ?? '',
      }
    : undefined
  return {
    licences,
    ...(parent?.group && parent.module && parent.version ? { parent } : {}),
  }
}

/** LICENSE, NOTICE and COPYING files at an archive's root or anywhere under META-INF. */
export const LICENCE_ENTRY =
  /^(?:META-INF\/(?:[\w.-]+\/)*)?(?:LICEN[CS]E|NOTICE|NOTICES|COPYING|THIRD[-_]PARTY[-_]NOTICES?)(?:[._-][\w.-]*)?$/i

export interface NativeLibrary {
  coordinate: Coordinate
  /** Licences the POM (or a parent POM) declares. */
  licences: Pom['licences']
  /** Licence and notice files found in the library's archives. */
  files: Array<{ path: string; text: string }>
  /** Where the artifact was read from, or undefined when it was not found. */
  source?: string
}

const RULE = '='.repeat(78)

export function formatNativeNotices(libraries: readonly NativeLibrary[]): string {
  const lines = (library: NativeLibrary) => {
    const licences = library.licences.length
      ? library.licences.map((l) => (l.url ? `${l.name} (${l.url})` : l.name)).join('; ')
      : 'no licence declared in its POM'
    const files = library.files.length
      ? `; ${library.files.length} licence/notice file(s) below`
      : ''
    const missing = library.source ? '' : '; artifact not found to read its files'
    return `${coordinateId(library.coordinate)}: ${licences}${files}${missing}`
  }
  const groups = new Map<string, { text: string; owners: string[] }>()
  for (const library of libraries)
    for (const file of library.files) {
      const text = file.text.trim()
      const group = groups.get(text) ?? { text, owners: [] }
      group.owners.push(`${coordinateId(library.coordinate)} (${file.path})`)
      groups.set(text, group)
    }
  return [
    'Cindl for Android: native libraries',
    [
      `The APK also contains these ${libraries.length} libraries from Maven repositories, each under`,
      'its own licence: the one its POM declares. The full texts of the common licences (Apache',
      'License 2.0, MIT) are in THIRD-PARTY-NOTICES.txt; every licence or notice file the libraries',
      'ship (which the Android build otherwise leaves out of the APK) is reproduced below.',
    ].join('\n'),
    libraries.map(lines).join('\n'),
    groups.size
      ? `Licence and notice files shipped in these libraries (${groups.size} distinct texts):`
      : 'The libraries ship no licence or notice files of their own.',
    ...[...groups.values()].map((group) => `${group.owners.join('\n')}\n\n${group.text}`),
  ].join(`\n\n${RULE}\n\n`)
}
