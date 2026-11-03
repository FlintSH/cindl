import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { run, tempDir, writeFiles } from './helpers.mjs'

const COMMIT = 'a'.repeat(40)
const REPO_URL = 'https://github.com/example/handbook'
const INFO = {
  commit: COMMIT,
  shortCommit: COMMIT.slice(0, 12),
  dirty: false,
  builtAt: '2026-11-03T08:00:00.000Z',
  source: 'git',
}

const page = (
  body,
  { stamp = COMMIT, meta = COMMIT, base = '/' } = {},
) => `<!doctype html>
<html><head>
<meta name="cindl:commit" content="${meta}">
<link rel="stylesheet" href="${base}assets/style.css">
<link rel="icon" href="${base}favicon.svg">
</head><body>
<nav><a href="${base}index.html">Home</a> <a href="${base}guide.html">Guide</a></nav>
${stamp ? `<p class="build-stamp" data-build-stamp data-commit="${stamp}"></p>` : ''}
${body}
</body></html>
`

function site(base = '/') {
  return {
    'index.html': page(
      '<h1 id="welcome">Welcome</h1><a href="guide.html#install">Install</a>',
      { base },
    ),
    'guide.html': page(
      `<h2 id="install">Install</h2><a href="${REPO_URL}/blob/main/README.md">README</a><img src="${base}assets/logo.svg" alt="">`,
      { base },
    ),
    '404.html': page('<h1>Not found</h1>', { stamp: null, base }),
    'assets/style.css': `@font-face{src:url(${base}assets/sans.woff2)}body{background:url("data:image/png;base64,AA==")}`,
    'assets/sans.woff2': 'font',
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'build-info.json': `${JSON.stringify(INFO)}\n`,
  }
}

/** Build a fixture site (with `changes`) and a fixture repository, then check it. */
function check(t, changes = {}, args = []) {
  const root = tempDir(t)
  writeFiles(root, { 'README.md': '# Fixture\n' })
  const dist = join(root, 'dist')
  writeFiles(dist, {
    ...site(args.includes('--base') ? args[args.indexOf('--base') + 1] : '/'),
    ...changes,
  })
  return run('check-docs-build.mjs', [
    '--dist',
    dist,
    '--root',
    root,
    '--repo-url',
    REPO_URL,
    ...args,
  ])
}

function assertFails(result, pattern) {
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, pattern)
}

describe('check-docs-build', () => {
  it('passes a complete, self-contained site', (t) => {
    const result = check(t)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /3 pages, .* local links \(1 with anchors\)/)
  })

  it('passes the same site under a sub-path, and rejects links that escape it', (t) => {
    assert.equal(check(t, {}, ['--base', '/cindl/']).code, 0)
    assertFails(
      check(
        t,
        {
          'guide.html': page(
            '<h2 id="install">Install</h2><a href="/other/page.html">x</a>',
            { base: '/cindl/' },
          ),
        },
        ['--base', '/cindl/'],
      ),
      /\/other\/page\.html is outside the site base \/cindl\//,
    )
  })

  it('finds missing pages, anchors and assets', (t) => {
    assertFails(
      check(t, { 'index.html': page('<a href="missing.html">Gone</a>') }),
      /index\.html: missing\.html does not exist in the build/,
    )
    assertFails(
      check(t, { 'index.html': page('<a href="guide.html#nowhere">Gone</a>') }),
      /index\.html: guide\.html#nowhere points to a missing anchor/,
    )
    assertFails(
      check(t, { 'assets/logo.svg': null }),
      /\/assets\/logo\.svg does not exist/,
    )
    assertFails(
      check(t, { 'assets/style.css': '@font-face{src:url(/assets/missing.woff2)}' }),
      /assets\/style\.css: \/assets\/missing\.woff2 does not exist/,
    )
  })

  it('rejects anything loaded from another origin', (t) => {
    assertFails(
      check(t, {
        'index.html': page('<script src="https://cdn.example.com/a.js"></script>'),
      }),
      /<script src> loads https:\/\/cdn\.example\.com\/a\.js from another origin/,
    )
    assertFails(
      check(t, {
        'index.html': page('<link rel="stylesheet" href="//fonts.example.com/css">'),
      }),
      /<link href> loads \/\/fonts\.example\.com\/css from another origin/,
    )
    assertFails(
      check(t, { 'assets/style.css': '@import url("https://fonts.example.com/x.css");' }),
      /@import https:\/\/fonts\.example\.com\/x\.css loads from another origin/,
    )
    assertFails(
      check(t, {
        'assets/style.css': 'body{background:url(https://img.example.com/a.png)}',
      }),
      /url\(https:\/\/img\.example\.com\/a\.png\) loads from another origin/,
    )
    // Ordinary external links are navigation, not loads.
    assert.equal(
      check(t, {
        '404.html': page('<a href="https://example.com/">x</a>', { stamp: null }),
      }).code,
      0,
    )
  })

  it('checks links to repository files and rejects javascript: links', (t) => {
    assertFails(
      check(t, {
        'guide.html': page(
          `<h2 id="install">x</h2><a href="${REPO_URL}/blob/main/NOPE.md">x</a>`,
        ),
      }),
      /names NOPE\.md, which does not exist/,
    )
    assertFails(
      check(t, {
        '404.html': page('<a href="javascript:alert(1)">x</a>', { stamp: null }),
      }),
      /javascript: link/,
    )
  })

  it('finds pages nothing links to', (t) => {
    assertFails(
      check(t, { 'orphan.html': page('<p>Alone</p>') }),
      /orphan\.html: no other page links here/,
    )
  })

  it('requires valid build provenance on every page', (t) => {
    assertFails(check(t, { 'build-info.json': null }), /build-info\.json is missing/)
    assertFails(
      check(t, { 'build-info.json': JSON.stringify({ ...INFO, commit: 'main' }) }),
      /commit must be a full SHA or null/,
    )
    assertFails(
      check(t, { 'guide.html': page('<h2 id="install">x</h2>', { stamp: null }) }),
      /guide\.html: needs exactly one build stamp/,
    )
    assertFails(
      check(t, {
        'guide.html': page('<h2 id="install">x</h2>', { meta: 'b'.repeat(40) }),
      }),
      /guide\.html: needs exactly one <meta name="cindl:commit"/,
    )
  })

  it('fails when there is no build to check', (t) => {
    const result = run('check-docs-build.mjs', ['--dist', join(tempDir(t), 'none')])
    assertFails(result, /has no index\.html; build first/)
  })
})
