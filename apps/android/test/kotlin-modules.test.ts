import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KOTLIN_MODULES } from '../scripts/kotlin-modules.ts'

// check-apk.ts fails an APK that lacks one of KOTLIN_MODULES. The list missed
// CindlFocus when that module came (delta check of 7dab9fe, S3), so it is read
// against the modules themselves.

const modules = join(import.meta.dirname, '..', 'modules')

/** Every `.kt` file under a directory. */
function kotlinFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? kotlinFiles(join(dir, entry.name))
      : entry.name.endsWith('.kt')
        ? [join(dir, entry.name)]
        : [],
  )
}

describe('the Kotlin modules the APK check requires', () => {
  it('are every local module, by the name its Module class declares', () => {
    const declared = readdirSync(modules)
      .flatMap((module) => kotlinFiles(join(modules, module, 'android')))
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/\bName\("([^"]+)"\)/g)].map(
          ([, name]) => name,
        ),
      )
      .sort()
    expect(declared).toEqual([...KOTLIN_MODULES].sort())
  })
})
