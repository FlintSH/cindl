#!/usr/bin/env node
// Build-output gate (ADR 0011). Real-flavour outputs must contain no synthetic
// fixture record (SYNTHETIC_FIXTURE_MARKERS from @cindl/fixtures/markers);
// demo-flavour outputs must carry the demo notice and label
// (SYNTHETIC_DEMO_NOTICE and SYNTHETIC_DEMO_LABEL from @cindl/contracts). No
// output may name an absolute source path or the build machine's paths.
// Rules live in scripts/lib/dist.mjs.
// Usage: node scripts/check-dist.mjs [--root <repository>]
//          [--real <folder or file>]... [--demo <folder or file>]...
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkOutputs, loadMarkers } from './lib/dist.mjs'
import { defaultRoot, report } from './lib/git.mjs'

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    real: { type: 'string', multiple: true },
    demo: { type: 'string', multiple: true },
  },
})
const root = resolve(values.root ?? defaultRoot)
const outputs = [
  ...(values.real ?? []).map((path) => ({ path: resolve(root, path), flavour: 'real' })),
  ...(values.demo ?? []).map((path) => ({ path: resolve(root, path), flavour: 'demo' })),
]
try {
  if (!outputs.length) throw new Error('pass at least one --real or --demo output')
  const loaded = await loadMarkers(root)
  const { errors, files, maps } = loaded.errors.length
    ? { errors: [], files: 0, maps: 0 }
    : checkOutputs(root, outputs, loaded)
  const real = outputs.filter((output) => output.flavour === 'real').length
  report(
    'build outputs',
    [...loaded.errors, ...errors],
    `${real} real and ${outputs.length - real} demo output(s), ${files} files: no fixture records in real outputs, the demo notice and label in demo outputs, ${maps} source map(s) with relative paths only, no build machine paths.`,
  )
} catch (error) {
  report('build outputs', [error.message], '')
}
