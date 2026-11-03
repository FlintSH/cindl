/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NO_LIVE_PICTURE, TAKE_CONTROL_WARNING } from '../src/work/screen.ts'

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )

describe('the agent screen on Android', () => {
  it('never opens the live picture: no source calls the viewer operations', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const callers = sourceFiles(src).filter((file) =>
      /['"]display\.(watch|frame|input|unwatch)['"]/.test(readFileSync(file, 'utf8')),
    )
    expect(callers).toEqual([])
  })

  it('says the picture is not in the app, and that control sends nothing from it', () => {
    expect(NO_LIVE_PICTURE).toMatch(/^The live picture is not in the Android app yet/)
    expect(TAKE_CONTROL_WARNING).toMatch(/cannot show the screen or send input/)
    expect(TAKE_CONTROL_WARNING).not.toMatch(/keystrokes go to/i)
  })
})
