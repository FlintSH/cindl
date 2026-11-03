import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadMarkers } from '../lib/dist.mjs'
import { repoRoot, run, tempDir, writeFiles } from './helpers.mjs'

// The labels and markers mirror the real contract shape without the real values.
const LABEL = 'Fixture demo'
const NOTICE = 'Fixture demo. Not connected; everything here is invented.'
const PACKAGES = {
  'packages/contracts/package.json': JSON.stringify({
    name: '@x/contracts',
    exports: { '.': './src/index.ts' },
  }),
  'packages/contracts/src/index.ts': `export const SYNTHETIC_DEMO_LABEL = '${LABEL}'\nexport const SYNTHETIC_DEMO_NOTICE = '${NOTICE}'\n`,
  'packages/fixtures/package.json': JSON.stringify({
    name: '@x/fixtures',
    exports: { './markers': './src/markers.ts' },
  }),
  'packages/fixtures/src/markers.ts':
    "export const SYNTHETIC_FIXTURE_MARKERS = ['Lumen & Kiln', 'srq-demo00000001'] as const\n",
}

const app = (body) => ({
  'index.html':
    '<!doctype html><title>Cindl</title><script src="./assets/app.js"></script>',
  'assets/app.js': `${body}\n//# sourceMappingURL=app.js.map`,
  'assets/app.js.map': JSON.stringify({
    version: 3,
    sources: ['../../src/app.ts'],
    mappings: '',
  }),
  'assets/font.woff2': Buffer.from([0, 1, 2, 3]),
})
const REAL = app(
  `const banner=${JSON.stringify(NOTICE)};const dot="${LABEL}, not connected";`,
)
const DEMO = app(
  `const banner=${JSON.stringify(NOTICE)};const studio="Lumen & Kiln";const dot="${LABEL}";`,
)

/** A fixture repository with the packages above and the given outputs. */
function check(t, outputs, args, packages = PACKAGES) {
  const root = tempDir(t)
  writeFiles(root, packages)
  for (const [dir, files] of Object.entries(outputs)) writeFiles(join(root, dir), files)
  return run('check-dist.mjs', ['--root', root, ...args])
}

function assertFails(result, pattern) {
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, pattern)
}

describe('check-dist', () => {
  it('passes a real output that keeps the demo label copy', (t) => {
    const result = check(t, { 'apps/web/dist': REAL }, ['--real', 'apps/web/dist'])
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /1 real and 0 demo output/)
  })

  it('fails a real output that contains a fixture record', (t) => {
    const leaked = { ...REAL, 'assets/chunk.js': 'const studio="Lumen & Kiln";' }
    assertFails(
      check(t, { 'apps/web/dist': leaked }, ['--real', 'apps/web/dist']),
      /assets\/chunk\.js: contains synthetic fixture records \("Lumen & Kiln"\)/,
    )
  })

  it('passes a labelled demo output and fails one without the notice or label', (t) => {
    const ok = check(t, { 'apps/web/dist-demo': DEMO }, ['--demo', 'apps/web/dist-demo'])
    assert.equal(ok.code, 0, ok.output)
    const unlabelled = app('const studio="Lumen & Kiln";')
    const result = check(t, { 'apps/web/dist-demo': unlabelled }, [
      '--demo',
      'apps/web/dist-demo',
    ])
    assertFails(
      result,
      /dist-demo: demo output lacks the demo notice \(SYNTHETIC_DEMO_NOTICE\)/,
    )
    assert.match(result.output, /lacks the demo label \(SYNTHETIC_DEMO_LABEL\)/)
  })

  it('checks a packaged single-file output such as app.asar', (t) => {
    const asar = {
      'app.asar': Buffer.concat([
        Buffer.from([0, 4, 0, 0]),
        Buffer.from('srq-demo00000001'),
      ]),
    }
    assertFails(
      check(t, { 'out/real': asar }, ['--real', 'out/real/app.asar']),
      /app\.asar: contains synthetic fixture records \("srq-demo00000001"\)/,
    )
    assertFails(
      check(t, { out: { 'release.aab': 'PK' } }, ['--real', 'out/release.aab']),
      /release\.aab: compressed archive; pass the extracted output/,
    )
  })

  it('rejects source maps with fixtures or absolute paths', (t) => {
    const withMap = (sources, extra = {}) => ({
      'apps/web/dist': {
        ...REAL,
        'assets/app.js.map': JSON.stringify({
          version: 3,
          sources,
          mappings: '',
          ...extra,
        }),
      },
    })
    const args = ['--real', 'apps/web/dist']
    assertFails(
      check(t, withMap(['../../../../packages/fixtures/src/data.ts']), args),
      /bundles the synthetic fixtures/,
    )
    assertFails(
      check(t, withMap(['/home/someone/cindl/src/a.ts']), args),
      /absolute source path/,
    )
    assertFails(check(t, withMap(['C:\\work\\a.ts']), args), /absolute source path/)
    assertFails(
      check(t, withMap(['a.ts'], { sourceRoot: 'file:///work/' }), args),
      /absolute sourceRoot/,
    )
  })

  it('rejects output that contains the checkout path', (t) => {
    const root = tempDir(t)
    writeFiles(root, PACKAGES)
    writeFiles(join(root, 'apps/web/dist'), {
      ...REAL,
      'assets/where.js': `const w=${JSON.stringify(root)};`,
    })
    assertFails(
      run('check-dist.mjs', ['--root', root, '--real', 'apps/web/dist']),
      /contains the build machine path/,
    )
  })

  it('fails instead of passing on missing or mislabelled input', (t) => {
    assertFails(check(t, {}, []), /pass at least one --real or --demo output/)
    assertFails(
      check(t, {}, ['--real', 'apps/web/dist']),
      /apps\/web\/dist: no build output here/,
    )
    const empty = tempDir(t)
    writeFiles(empty, PACKAGES)
    mkdirSync(join(empty, 'apps/web/dist'), { recursive: true })
    assertFails(
      run('check-dist.mjs', ['--root', empty, '--real', 'apps/web/dist']),
      /apps\/web\/dist: is empty; there is nothing to check/,
    )
    assertFails(
      check(t, { 'apps/web/dist-demo': DEMO }, ['--real', 'apps/web/dist-demo']),
      /dist-demo: is a demo build; pass it with --demo/,
    )
    const noMarkers = {
      ...PACKAGES,
      'packages/fixtures/src/markers.ts': 'export const SYNTHETIC_FIXTURE_MARKERS = []\n',
    }
    assertFails(
      check(t, { 'apps/web/dist': REAL }, ['--real', 'apps/web/dist'], noMarkers),
      /must be a non-empty list/,
    )
  })

  it('loads the real markers and labels from their packages', async () => {
    const { markers, labels, errors } = await loadMarkers(repoRoot)
    assert.deepEqual(errors, [])
    assert.ok(markers.includes('Lumen & Kiln'))
    assert.ok(labels.notice.startsWith(labels.label))
  })
})
