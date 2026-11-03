/**
 * Output gates for the two flavours (ADR 0011). A real-flavour output must
 * contain none of the synthetic fixture markers; every renderer must keep the
 * demo notice (it is required UI copy, never compiled out); a demo-flavour
 * main bundle must actually contain the scenario.
 */
import { SYNTHETIC_DEMO_NOTICE } from '@cindl/contracts'
import { SYNTHETIC_FIXTURE_MARKERS } from '@cindl/fixtures/markers'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** Every file under `target` (or `target` itself). */
export function filesUnder(target: string): string[] {
  if (statSync(target).isFile()) return [target]
  return readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/** Fixture markers found in the files under `targets`, as "file: marker". */
export function markerHits(targets: readonly string[]): string[] {
  const hits: string[] = []
  for (const file of targets.flatMap(filesUnder)) {
    const text = readFileSync(file).toString('latin1')
    for (const marker of SYNTHETIC_FIXTURE_MARKERS)
      if (text.includes(marker)) hits.push(`${file}: ${marker}`)
  }
  return hits
}

/** True when some file under `targets` carries the demo notice copy. */
export function hasDemoNotice(targets: readonly string[]): boolean {
  return targets
    .flatMap(filesUnder)
    .some((file) => readFileSync(file, 'utf8').includes(SYNTHETIC_DEMO_NOTICE))
}

export interface GateInput {
  kind: 'real' | 'demo'
  /** Main-process code: the bundles, or the packaged app.asar. */
  main: readonly string[]
  /** The renderer directory. */
  renderer: string
}

/** Problems with one flavour's output; empty when it passes. */
export function gateProblems(input: GateInput): string[] {
  const problems: string[] = []
  const rendererHits = markerHits([input.renderer])
  if (rendererHits.length)
    problems.push(
      `renderer contains synthetic fixture records: ${rendererHits.join(', ')}`,
    )
  if (!hasDemoNotice([input.renderer]))
    problems.push(
      'renderer lacks the synthetic demo notice (it must never be compiled out)',
    )
  const mainHits = markerHits(input.main)
  if (input.kind === 'real' && mainHits.length)
    problems.push(
      `real flavour contains synthetic fixture records: ${mainHits.join(', ')}`,
    )
  if (input.kind === 'demo' && !mainHits.length)
    problems.push('demo flavour main bundle does not contain the synthetic scenario')
  return problems
}
