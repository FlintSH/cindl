#!/usr/bin/env node
// Production-output gate, run after a production build. It fails if the output
// contains synthetic demo data (markers derived from packages/fixtures/src),
// if a source map bundles the fixtures or names an absolute path, or if any
// output file contains the build machine's checkout or home directory path.
// Never point it at a demo build (apps/web/dist-demo): that output is meant to
// contain the scenario. Rules live in scripts/lib/dist.mjs.
// Usage: node scripts/check-dist.mjs [--root <repository>] [<output dir> ...]
//        (default: apps/web/dist)
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkOutputs, demoMarkers } from './lib/dist.mjs'
import { defaultRoot, report } from './lib/git.mjs'

const { values, positionals } = parseArgs({
  options: { root: { type: 'string' } },
  allowPositionals: true,
})
const root = resolve(values.root ?? defaultRoot)
const dirs = (positionals.length ? positionals : ['apps/web/dist']).map((dir) =>
  resolve(root, dir),
)
try {
  const { markers, errors: markerErrors } = await demoMarkers(root)
  const { errors, files, maps } = checkOutputs(root, dirs, markers)
  report(
    'production output',
    [...markerErrors, ...errors],
    `${files} text files in ${dirs.length} output folder(s) checked against ${markers.length} synthetic demo markers; ${maps} source map(s) have only relative paths and no fixtures.`,
  )
} catch (error) {
  report('production output', [error.message], '')
}
