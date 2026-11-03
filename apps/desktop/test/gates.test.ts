import { SYNTHETIC_DEMO_NOTICE } from '@cindl/contracts'
import { SYNTHETIC_FIXTURE_MARKERS } from '@cindl/fixtures/markers'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flavourFromArgs, flavours } from '../scripts/flavours.ts'
import { gateProblems, markerHits } from '../scripts/gates.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cindl-gates-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function output(options: { main: string; renderer: string }) {
  const main = path.join(dir, 'main.cjs')
  const renderer = path.join(dir, 'renderer')
  mkdirSync(path.join(renderer, 'assets'), { recursive: true })
  writeFileSync(main, options.main)
  writeFileSync(path.join(renderer, 'assets', 'index.js'), options.renderer)
  return { main: [main], renderer }
}

const marker = SYNTHETIC_FIXTURE_MARKERS[1]
const labelledRenderer = `const notice = ${JSON.stringify(SYNTHETIC_DEMO_NOTICE)}`

describe('flavour output gates', () => {
  it('passes a clean real flavour with the label copy in its renderer', () => {
    expect(
      gateProblems({
        kind: 'real',
        ...output({ main: 'app()', renderer: labelledRenderer }),
      }),
    ).toEqual([])
  })

  it('fails a real flavour whose main bundle carries fixture records', () => {
    const problems = gateProblems({
      kind: 'real',
      ...output({
        main: `const origin = "https://${marker}"`,
        renderer: labelledRenderer,
      }),
    })
    expect(problems.join('\n')).toContain(
      'real flavour contains synthetic fixture records',
    )
  })

  it('fails any renderer with fixture records or without the label', () => {
    const withRecords = gateProblems({
      kind: 'demo',
      ...output({ main: marker, renderer: `${labelledRenderer};"${marker}"` }),
    })
    expect(withRecords.join('\n')).toContain(
      'renderer contains synthetic fixture records',
    )
    const unlabelled = gateProblems({
      kind: 'real',
      ...output({ main: 'x', renderer: 'x' }),
    })
    expect(unlabelled.join('\n')).toContain('lacks the synthetic demo notice')
  })

  it('fails a demo flavour without the scenario', () => {
    const problems = gateProblems({
      kind: 'demo',
      ...output({ main: 'x', renderer: labelledRenderer }),
    })
    expect(problems.join('\n')).toContain('does not contain the synthetic scenario')
  })

  it('finds markers in binary containers such as app.asar', () => {
    const asar = path.join(dir, 'app.asar')
    writeFileSync(
      asar,
      Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(marker), Buffer.from([0])]),
    )
    expect(markerHits([asar])).toEqual([`${asar}: ${marker}`])
  })
})

describe('flavour selection', () => {
  it('defaults to the real app and accepts the demo explicitly', () => {
    expect(flavourFromArgs([])).toBe(flavours.real)
    expect(flavourFromArgs(['--flavour', 'demo'])).toBe(flavours.demo)
    expect(flavourFromArgs(['--flavour=demo'])).toBe(flavours.demo)
    expect(() => flavourFromArgs(['--flavour', 'debug'])).toThrow(/Unknown flavour/)
  })

  it('gives the demo its own identity', () => {
    expect(flavours.demo.productName).toBe('Cindl Demo')
    expect(flavours.demo.appId).not.toBe(flavours.real.appId)
    expect(flavours.demo.outDir).not.toBe(flavours.real.outDir)
    expect(flavours.demo.releaseDir).not.toBe(flavours.real.releaseDir)
    expect(flavours.real.entry).toBe('src/main/index.ts')
  })
})
