import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { demoMarkers } from '../lib/dist.mjs'
import { repoRoot, run, tempDir, writeFiles } from './helpers.mjs'

const FIXTURE_DATA = `// SYNTHETIC: Lumen & Kiln is invented.
export const origin = 'https://hermes.synthetic.invalid'
export const conversations = [{ id: 'demo-main', title: 'Glaze order 42 for Quill Street' }]
export const shared = 'Not connected to Hermes'
`
const PRODUCTION_SOURCE = `export const status = 'Not connected to Hermes'\n`

/** A fixture repository with fixtures and production source, plus a dist folder. */
function check(t, dist, { files = {}, args } = {}) {
  const root = tempDir(t)
  writeFiles(root, {
    'packages/fixtures/src/data.ts': FIXTURE_DATA,
    'apps/web/src/status.ts': PRODUCTION_SOURCE,
    ...files,
  })
  writeFiles(join(root, 'apps/web/dist'), dist)
  return run('check-dist.mjs', ['--root', root, ...(args ?? ['apps/web/dist'])])
}

const CLEAN = {
  'index.html':
    '<!doctype html><title>Cindl</title><script src="./assets/app.js"></script>',
  'assets/app.js':
    'const status="Not connected to Hermes";export{status};\n//# sourceMappingURL=app.js.map',
  'assets/app.js.map': JSON.stringify({
    version: 3,
    sources: ['../../src/status.ts', '../../../../node_modules/.pnpm/react/index.js'],
    mappings: '',
  }),
  'assets/font.woff2': Buffer.from([0, 1, 2]),
}

function assertFails(result, pattern) {
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, pattern)
}

describe('check-dist', () => {
  it('passes a production build without demo data', (t) => {
    const result = check(t, CLEAN)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /1 source map\(s\) have only relative paths/)
  })

  it('finds demo markers and fixture literals in the output', (t) => {
    assertFails(
      check(t, { ...CLEAN, 'assets/chunk.js': 'const id="demo-main";' }),
      /assets\/chunk\.js: contains synthetic demo data \("demo-main"\)/,
    )
    assertFails(
      check(t, {
        ...CLEAN,
        'assets/chunk.js': 'const t="Glaze order 42 for Quill Street";',
      }),
      /contains synthetic demo data \("Glaze order 42 for Quill Street"\)/,
    )
    assertFails(
      check(t, { ...CLEAN, 'index.html': '<p>Lumen &amp; Kiln</p><p>Lumen & Kiln</p>' }),
      /index\.html: contains synthetic demo data \("Lumen & Kiln"\)/,
    )
  })

  it('does not treat strings that production code also uses as markers', (t) => {
    const result = check(t, CLEAN)
    assert.equal(result.code, 0, result.output)
  })

  it('rejects source maps with fixtures or absolute paths', (t) => {
    const map = (sources, extra = {}) => ({
      ...CLEAN,
      'assets/app.js.map': JSON.stringify({
        version: 3,
        sources,
        mappings: '',
        ...extra,
      }),
    })
    assertFails(
      check(t, map(['../../../../packages/fixtures/src/data.ts'])),
      /bundles the synthetic fixtures/,
    )
    assertFails(check(t, map(['/home/someone/cindl/src/a.ts'])), /absolute source path/)
    assertFails(check(t, map(['C:\\work\\a.ts'])), /absolute source path/)
    assertFails(
      check(t, map(['a.ts'], { sourceRoot: 'file:///work/' })),
      /absolute sourceRoot/,
    )
  })

  it('rejects output that contains the checkout path', (t) => {
    const root = tempDir(t)
    writeFiles(root, {
      'packages/fixtures/src/data.ts': FIXTURE_DATA,
      'apps/web/src/status.ts': PRODUCTION_SOURCE,
    })
    writeFiles(join(root, 'apps/web/dist'), {
      ...CLEAN,
      'assets/app.js': `const where=${JSON.stringify(join(root, 'apps/web/src/status.ts'))};`,
    })
    assertFails(
      run('check-dist.mjs', ['--root', root, 'apps/web/dist']),
      /contains the build machine path/,
    )
  })

  it('refuses a demo build and missing output instead of passing', (t) => {
    assertFails(
      check(t, CLEAN, { args: ['apps/web/dist', 'apps/web/dist-demo'] }),
      /dist-demo: no build output here/,
    )
    const root = tempDir(t)
    writeFiles(root, { 'packages/fixtures/src/data.ts': FIXTURE_DATA })
    writeFiles(join(root, 'apps/web/dist-demo'), CLEAN)
    assertFails(
      run('check-dist.mjs', ['--root', root, 'apps/web/dist-demo']),
      /apps\/web\/dist-demo: is a demo build/,
    )
  })

  it('fails when its fixed markers no longer occur in the fixtures', (t) => {
    assertFails(
      check(t, CLEAN, {
        files: {
          'packages/fixtures/src/data.ts': FIXTURE_DATA.replace('demo-main', 'demo-home'),
        },
      }),
      /EXTRA_MARKERS: "demo-main" no longer occurs/,
    )
  })

  it('derives markers from the real fixtures package', async () => {
    // An empty or stale marker set would let any output pass.
    const { markers, errors } = await demoMarkers(repoRoot)
    assert.deepEqual(errors, [])
    assert.ok(markers.length >= 20, `only ${markers.length} markers`)
    for (const marker of ['Lumen & Kiln', 'hermes.synthetic.invalid', 'demo-main'])
      assert.ok(markers.includes(marker), marker)
  })
})
