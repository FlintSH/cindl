/**
 * Bundle gate for ADR 0011. A real (production) bundle must contain no
 * synthetic fixture record; a demo bundle must carry the demo notice.
 * Hermes bytecode stores string literals as Latin-1 or UTF-16LE, so both
 * encodings are searched.
 *
 *   node apps/android/scripts/check-bundle.ts production <bundle>
 *   node apps/android/scripts/check-bundle.ts demo <bundle>
 */
import { readFileSync } from 'node:fs'
import { SYNTHETIC_DEMO_NOTICE } from '@cindl/contracts'
import { SYNTHETIC_FIXTURE_MARKERS } from '@cindl/fixtures/markers'

const [flavour, file] = process.argv.slice(2)
if ((flavour !== 'production' && flavour !== 'demo') || !file) {
  console.error('Usage: check-bundle.ts <production|demo> <bundle>')
  process.exit(2)
}
const bundle = readFileSync(file)
const contains = (text: string) =>
  bundle.includes(Buffer.from(text, 'latin1')) ||
  bundle.includes(Buffer.from(text, 'utf16le'))

const found = SYNTHETIC_FIXTURE_MARKERS.filter(contains)
if (flavour === 'production' && found.length) {
  console.error(
    `Production bundle contains synthetic fixture records: ${found.join(', ')}`,
  )
  process.exit(1)
}
if (flavour === 'demo' && !contains(SYNTHETIC_DEMO_NOTICE)) {
  console.error('Demo bundle does not contain the synthetic demo notice')
  process.exit(1)
}
if (!contains(SYNTHETIC_DEMO_NOTICE)) {
  console.error('Bundle does not contain the demo notice; it must stay in every build')
  process.exit(1)
}
console.log(
  flavour === 'production'
    ? `OK: no fixture markers (${SYNTHETIC_FIXTURE_MARKERS.length} checked); demo notice present`
    : `OK: demo notice present; fixture markers found: ${found.length}`,
)
