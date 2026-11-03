import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LICENCE_ENTRY, type NativeLibrary } from './native.ts'

const MAX_BUFFER = 512 * 1024 * 1024

/**
 * Entries of a JAR or AAR. An empty archive (resource-only AARs ship an empty
 * classes.jar) has none; any other archive `unzip` cannot read stops the run,
 * because notices fail closed.
 */
export function archiveEntries(archive: string): string[] {
  try {
    return execFileSync('unzip', ['-Z1', archive], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    })
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    const output = (error as { stdout?: unknown }).stdout
    if (typeof output === 'string' && output.trim() === 'Empty zipfile.') return []
    throw new Error(`Could not read ${archive} to collect its licence files`, {
      cause: error,
    })
  }
}

/** Licence and notice files in a JAR, or in an AAR and the JARs inside it (classes.jar, libs/*.jar). */
export function licenceFiles(archive: string): NativeLibrary['files'] {
  const all = archiveEntries(archive)
  const files = all
    .filter((entry) => LICENCE_ENTRY.test(entry))
    .map((entry) => ({
      path: entry,
      text: execFileSync('unzip', ['-p', archive, entry], {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
      }),
    }))
  if (!archive.endsWith('.aar')) return files
  for (const inner of all.filter(
    (entry) => entry === 'classes.jar' || /^libs\/[^/]+\.jar$/.test(entry),
  )) {
    const work = mkdtempSync(join(tmpdir(), 'cindl-native-notices-'))
    try {
      const jar = join(work, 'inner.jar')
      writeFileSync(
        jar,
        execFileSync('unzip', ['-p', archive, inner], { maxBuffer: MAX_BUFFER }),
      )
      for (const file of licenceFiles(jar))
        files.push({ path: `${inner}!/${file.path}`, text: file.text })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  return files
}
